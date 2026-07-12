# 11.4 트랜잭션과 동시성 제어 — 동시에 실행해도 불변식을 지킨다

트랜잭션 격리는 요청을 하나씩 실행하는 환상이 아니다. 여러 연산이 섞인 스케줄에서 어떤 version을 볼 수 있고 어떤 충돌을 기다리거나 거절할지 정하는 계약이다. lock과 MVCC는 서로를 대체하는 단일 기술이 아니며, 읽기 대기·쓰기 충돌·오래된 version이라는 서로 다른 비용으로 계약을 구현한다.

## 학습 목표

- 트랜잭션의 원자성·일관성·격리·내구성을 담당 구성 요소와 관찰 증거로 분해한다.
- dirty read·non-repeatable read·phantom·lost update·write skew를 실행 순서와 불변식으로 구분한다.
- lock과 latch, two-phase locking과 wait-for graph의 보호 대상·수명·교착 경계를 설명한다.
- MVCC snapshot과 version metadata로 단순한 visibility 판정을 수행한다.
- 격리 수준 이름보다 실제 허용 이상 현상과 엔진별 보장을 근거로 트랜잭션 설계를 판단한다.

## 배경: 각 문장이 원자적이어도 주문은 틀릴 수 있다

재고가 5개 남은 상품에 두 주문이 동시에 4개씩 들어왔다고 하자. 두 요청이 다음 순서를 실행한다.

```text
T1: read available = 5
T2: read available = 5
T1: write available = 1
T2: write available = 1
```

각 `SELECT`와 `UPDATE`가 오류 없이 끝나고 최종 값도 음수가 아니지만, 총 8개를 판매하고 재고는 1개라고 기록했다. “수량은 음수가 아니다”만 검사하면 더 중요한 불변식인 `초기 재고 - 확정 수량 합 = 현재 재고`를 놓친다.

다음 원자적 조건부 갱신은 다른 계약을 만든다.

```sql
UPDATE inventory
SET available_quantity = available_quantity - :quantity
WHERE product_id = :product_id
  AND available_quantity >= :quantity;
```

영향받은 행이 1개일 때만 주문을 확정하면 두 갱신이 같은 최신 값을 덮어쓰지 않는다. 그러나 주문 행 생성과 재고 차감이 함께 성공하거나 실패해야 한다면 둘을 하나의 트랜잭션에 두고, 교착·serialization failure 때 전체 단위를 다시 실행해야 한다. 격리는 SQL 문법이 아니라 불변식과 실패 처리까지 포함한 설계다.

## ACID를 구성 요소로 분해한다

ACID는 네 독립 기능의 체크리스트가 아니라 여러 하위 메커니즘이 조립한 계약이다.

| 속성 | 판단 질문 | 주된 메커니즘 | 관찰 증거 |
|---|---|---|---|
| 원자성(atomicity) | 중간 실패 후 일부 효과만 남는가? | undo·version·transaction state | rollback 뒤 상태, recovery log |
| 일관성(consistency) | 정의한 불변식과 제약이 유지되는가? | application logic, constraint, isolation | 최종 상태와 위반 기록 |
| 격리(isolation) | 동시 스케줄에서 어떤 결과가 허용되는가? | lock, MVCC, validation | read version, wait, abort, serialization graph |
| 내구성(durability) | 성공 응답 뒤 crash에도 남는가? | WAL, flush, recovery | commit/log position, restart 결과 |

여기서 일관성은 DBMS가 업무 규칙을 자동으로 알아낸다는 뜻이 아니다. 개발자가 unique·check·foreign key와 트랜잭션 로직으로 불변식을 표현하고, DBMS의 격리·복구 계약이 동시성·실패에서도 이를 유지할 토대를 제공한다.

## 스케줄로 이상 현상을 읽는다

트랜잭션 스케줄(schedule)은 여러 트랜잭션의 read·write·commit·abort가 섞인 순서다. 격리 수준을 이해하려면 현상 이름보다 `누가 어느 version을 언제 읽었는가`를 기록한다.

### dirty read

```text
T1: W(status = 'PAID')
T2: R(status) → 'PAID'
T1: ABORT
```

T2가 아직 commit하지 않은 T1의 값을 읽었다. T2가 이를 바탕으로 외부 행동을 했다면 T1 rollback으로 되돌릴 수 없는 결과가 생긴다.

### non-repeatable read

```text
T1: R(status) → 'READY'
T2: W(status = 'PAID'); COMMIT
T1: R(status) → 'PAID'
```

한 트랜잭션 안에서 같은 행을 다시 읽었는데 다른 committed 값을 본다. statement마다 새 snapshot을 쓰는 계약에서는 허용될 수 있다.

### phantom

```text
T1: R(count WHERE status = 'READY') → 10
T2: INSERT(status = 'READY'); COMMIT
T1: R(same predicate) → 11
```

기존 행 값이 바뀐 것이 아니라 predicate에 새로 들어오는 행이 생겼다. 기존 record만 lock해서는 삽입을 막지 못한다. key range/gap lock, predicate lock 또는 serialization validation 같은 메커니즘이 필요할 수 있다.

### lost update

```text
T1: R(quantity = 5)
T2: R(quantity = 5)
T1: W(quantity = 1); COMMIT
T2: W(quantity = 1); COMMIT
```

T1의 변경을 T2가 오래된 값으로 덮었다. DBMS가 모든 read-modify-write 형태를 자동으로 감지한다고 가정하지 않는다. 원자적 update, version 조건을 둔 optimistic compare-and-swap, locking read 또는 충분한 격리가 대안이다.

### write skew

두 창고 중 최소 하나는 주문을 처리해야 한다는 불변식이 있다고 하자.

```text
initial: warehouse A = ON, B = ON

T1: snapshot에서 A=ON, B=ON 확인; W(A=OFF)
T2: 같은 snapshot에서 A=ON, B=ON 확인; W(B=OFF)
T1: COMMIT
T2: COMMIT
final: A=OFF, B=OFF
```

서로 다른 행을 써서 write-write 충돌이 없지만 함께 보면 불변식을 깬다. snapshot isolation이 dirty read와 lost update 일부를 막더라도 serializable과 같지 않을 수 있는 대표 경계다.

## lock 기반 동시성 제어

### shared·exclusive와 granularity

단순 lock 모델에서 shared(S) lock끼리는 함께 보유할 수 있고 exclusive(X) lock은 같은 대상의 다른 S/X와 충돌한다.

| 보유 \ 요청 | S | X |
|---|---|---|
| S | 허용 | 대기 |
| X | 대기 | 대기 |

대상은 table·page·row·index record·key range일 수 있다. 작은 granularity는 서로 다른 행의 동시성을 높이지만 lock entry와 탐색 비용을 늘린다. 큰 granularity는 관리 비용을 줄이지만 무관한 작업까지 막는다. intention lock은 table과 row 같은 계층적 lock을 조정하는 대표 메커니즘이다.

실제 lock 대상은 SQL의 논리 predicate와 정확히 같지 않을 수 있다. InnoDB의 locking read·update가 scan한 index record와 range에 lock을 설정하는 것처럼 접근 경로가 lock footprint를 바꿀 수 있다. 부적절한 인덱스는 읽기만 느리게 하는 것이 아니라 더 넓은 범위를 오래 잠글 수 있다.

### lock과 latch를 구분한다

- lock은 트랜잭션 사이의 논리 데이터와 격리를 보호하며 commit·abort까지 유지될 수 있다.
- latch는 buffer page, B+트리 node나 lock table 같은 메모리 구조의 짧은 변경을 보호한다.

둘 다 대기를 만들지만 해결책이 다르다. 긴 트랜잭션을 줄이는 것은 row lock wait에 효과적이지만 hot index root latch는 key 분포, tree algorithm과 critical section이 핵심일 수 있다. 제품 wait event가 둘을 구분하는지 확인한다.

### two-phase locking

two-phase locking(2PL)은 lock을 얻는 growing phase와 lock을 놓는 shrinking phase를 분리해 conflict-serializable schedule을 만든다. strict 2PL은 write lock 등을 commit·abort까지 유지해 다른 트랜잭션이 미완료 값을 읽거나 덮는 문제와 recovery를 단순화한다.

```text
growing:   acquire S(A) → acquire X(B)
shrinking: commit/abort → release locks
```

대가는 blocking과 deadlock이다. 트랜잭션이 I/O나 외부 API 응답을 기다리는 동안 lock을 보유하면 다른 요청의 대기열이 자란다.

### wait-for graph와 deadlock

```text
T1 holds X(A), requests X(B) → waits for T2
T2 holds X(B), requests X(A) → waits for T1

wait-for graph: T1 → T2 → T1
```

cycle은 어느 트랜잭션도 스스로 진행할 수 없는 deadlock이다. DBMS는 graph cycle을 감지해 victim을 abort하거나 timeout으로 빠져나올 수 있다. timeout은 단순한 느린 wait와 deadlock을 정확히 구분하지 않는다.

교착은 오류 없는 예외 상황이 아니라 정상적인 동시 실행 결과일 수 있다. 애플리케이션은 엔진 문서가 지정한 단위, 보통 전체 트랜잭션을 재시도해야 한다. 재시도 전 외부 부수 효과가 있었다면 DB rollback만으로 안전하지 않으므로 트랜잭션 경계를 다시 설계한다.

## MVCC와 visibility

다중 버전 동시성 제어(multi-version concurrency control, MVCC)는 update가 기존 version을 즉시 덮어쓰기보다 새 version을 만들고 reader가 snapshot에 보이는 version을 선택하게 한다.

```text
inventory(product=7)

v1: quantity=5, created_by=T10, ended_by=T20
v2: quantity=1, created_by=T20, ended_by=∞
```

단순화한 snapshot은 다음 정보를 가질 수 있다.

```text
snapshot S:
  S 생성 전에 commit한 transaction 집합 또는 경계
  S 생성 시 아직 active인 transaction 집합
  현재 transaction id
```

version visibility의 개념적 판정은 다음과 같다.

1. version을 만든 transaction이 내 transaction이면 내 쓰기 규칙에 따라 본다.
2. creator가 snapshot 전에 commit했고 snapshot 당시 active가 아니면 생성은 보일 후보이다.
3. version을 끝낸 transaction이 snapshot 뒤에 commit했거나 아직 active면 이전 version은 여전히 보인다.
4. creator가 abort했거나 snapshot 뒤에 commit했다면 보이지 않는다.

실제 PostgreSQL tuple의 transaction ID, InnoDB undo record와 read view, SQLite WAL snapshot은 metadata 위치와 규칙이 다르다. 위 모델은 공통 개념이지 어떤 제품의 pseudo-code가 아니다.

### MVCC가 없애는 대기와 남기는 충돌

reader는 writer가 만든 미완료 최신 version 대신 이전 committed version을 읽어 많은 read-write blocking을 피할 수 있다. 그러나 다음은 남는다.

- 같은 행을 갱신하는 writer끼리의 write-write 충돌
- unique·foreign key와 predicate 불변식을 위한 조정
- serializable 보장을 위한 predicate conflict 감지
- 오래된 snapshot 때문에 version을 제거하지 못하는 공간 비용

“MVCC는 lock을 쓰지 않는다”는 설명이 틀린 이유다. MVCC 엔진도 write lock, metadata latch와 schema lock을 사용할 수 있다.

### 오래된 snapshot과 version cleanup

어떤 reader가 오래된 snapshot을 유지하면 그 snapshot이 볼 수 있는 이전 version을 제거할 수 없다. dead tuple 또는 undo history가 늘고, index-only visibility 판정과 page density, backup·replication 유지 범위에도 영향을 줄 수 있다.

관찰할 항목은 제품마다 다르지만 공통 질문은 같다.

- 가장 오래 열린 transaction과 snapshot의 나이는 얼마인가?
- reclaim 가능한 version과 아직 보존해야 하는 version은 얼마인가?
- cleanup/vacuum/purge 처리량이 version 생성률을 따라가는가?
- 장기 transaction이 connection leak, idle-in-transaction 또는 분석 query에서 왔는가?

cleanup을 더 공격적으로 실행하기 전에 오래된 snapshot이라는 원인을 제거하지 않으면 같은 debt가 다시 쌓인다.

## 격리 수준 이름보다 현상을 확인한다

SQL 표준의 isolation level 이름은 출발점이지만 실제 엔진은 lock·snapshot·serialization detection을 다르게 구현한다. 같은 `REPEATABLE READ` 이름도 snapshot 생성 시점, phantom 처리와 locking read 동작이 다를 수 있다.

| 확인 질문 | 이유 |
|---|---|
| snapshot은 transaction 시작, 첫 read, statement마다 언제 생성되는가? | 반복 read가 보는 version 결정 |
| plain read와 locking read가 같은 상태를 보는가? | snapshot/current read 혼합 경계 |
| range predicate의 삽입을 어떻게 다루는가? | phantom·write skew 판단 |
| write-write 또는 serialization conflict에서 누가 abort하는가? | 재시도 책임과 부하 |
| read-only·deferrable 같은 별도 계약이 있는가? | 대기와 abort tradeoff |

필요한 불변식에서 역으로 선택한다. 단일 재고 행의 음수 방지는 조건부 atomic update와 제약으로 충분할 수 있다. 여러 행의 합이나 “최소 하나” 조건은 serializable, 명시적 lock 또는 불변식을 한 행·constraint로 재표현하는 설계를 요구할 수 있다.

## 관찰 실험: 두 트랜잭션의 timeline

실험은 sleep 시간에 의존하지 않고 barrier로 interleaving을 통제한다.

```text
time | T1                         | T2                         | observe
-----+----------------------------+----------------------------+-----------------
t0   | BEGIN                      | BEGIN                      | snapshot/id
t1   | read inventory             |                            | version read
t2   | barrier signal             | read inventory             | version read
t3   | update product 7           | update product 7           | lock/wait
t4   | COMMIT/ABORT               | COMMIT/ABORT               | final, error
```

각 실험 전에 다음을 적는다.

1. 지켜야 할 불변식과 허용할 현상
2. 각 read가 볼 것으로 예상한 version
3. 어느 operation이 대기하거나 abort할지
4. 반증 조건

최종 값만 기록하면 lost update가 우연히 발생하지 않은 실행과 계약상 방지된 실행을 구분하지 못한다. transaction ID, snapshot/read view, lock wait와 오류 코드까지 남긴다. deadlock 실험은 A→B와 B→A 순서를 강제하고 wait-for edge와 victim을 대응시킨다.

## 실무 관점

### 트랜잭션 안에서 외부 API를 호출하지 않는다

원격 호출은 지연과 실패 상한이 DBMS 통제 밖에 있다. 그동안 lock과 snapshot을 유지하면 대기·version cleanup 비용이 커진다. 그렇다고 호출을 밖으로 옮기면 DB와 외부 상태의 원자성이 자동으로 생기지 않는다. 이 챕터에서는 Saga·outbox를 확장하지 않으며, 먼저 로컬 DB 불변식과 외부 workflow의 별도 실패 계약을 인정한다.

### 격리 수준을 무조건 높이는 것도 해법이 아니다

더 강한 격리는 불가능한 schedule을 늘리지만 대기나 serialization abort·retry를 늘릴 수 있다. 먼저 조건부 update, unique constraint와 transaction 범위 축소로 불변식을 직접 표현하고, 여러 row predicate가 남을 때 강한 격리를 선택한다.

### `SKIP LOCKED`는 일반 조회의 정확성 해법이 아니다

작업 큐 consumer처럼 잠긴 항목을 다른 worker가 처리할 수 있는 경우에는 유용하다. 재고 합계나 모든 미처리 주문을 정확히 봐야 하는 query에서 사용하면 잠긴 행을 조용히 누락한다. 누락이 계약에 포함되는지 먼저 명시한다.

## 정리

- 격리는 동시 스케줄에서 read version, wait와 abort를 정하는 계약이다.
- dirty read·non-repeatable read·phantom·lost update·write skew는 서로 다른 실행 순서와 불변식 위반이다.
- 2PL은 serializable한 충돌 순서를 만들 수 있지만 blocking과 deadlock을 낳는다.
- MVCC는 이전 committed version으로 read-write 대기를 줄이지만 writer 충돌과 오래된 version cleanup 비용을 남긴다.
- lock과 latch는 보호 대상과 수명이 다르며 실행 계획의 접근 범위가 lock footprint를 바꿀 수 있다.
- isolation level 이름만 믿지 말고 snapshot 시점, locking read, predicate conflict와 retry 계약을 제품 문서와 실험으로 확인한다.

## 확인 문제

1. 두 트랜잭션이 서로 다른 의사 행을 `OFF`로 바꿔 “당직 의사가 최소 한 명”이라는 불변식을 깼다. write-write 충돌이 없는데도 가능한 이유는 무엇인가?
2. `UPDATE ... WHERE`가 예상보다 많은 row lock을 만들었다. 실행 계획과 인덱스를 함께 봐야 하는 이유는 무엇인가?
3. MVCC 기반 DB에서 장기 read-only transaction이 쓰기를 직접 막지 않는데도 성능·공간 문제를 만드는 경로를 설명하라.
4. deadlock victim transaction을 statement 하나만 재시도하면 위험한 이유는 무엇인가?

<details>
<summary>정답과 해설</summary>

1. 두 transaction이 같은 snapshot에서 전체 predicate를 읽고 서로 다른 row를 써서 직접 충돌하지 않는 write skew다. serializable conflict detection, predicate/range lock 또는 불변식을 단일 constraint 대상에 모으는 설계가 필요하다.
2. 일부 엔진은 predicate 자체가 아니라 scan한 index record·range에 lock을 둔다. 비효율적인 접근 경로가 넓은 범위를 scan하면 lock footprint와 대기가 함께 커질 수 있다.
3. 오래된 snapshot이 볼 수 있는 이전 version을 vacuum/purge가 제거하지 못한다. dead tuple·undo history와 index/table 공간, version traversal 비용이 늘며 cleanup debt가 쌓인다.
4. deadlock 처리에서 엔진이 전체 transaction을 rollback했을 수 있고 앞선 statement의 효과·읽기 전제가 사라졌다. 공식 오류 계약을 확인하고 전체 transaction 함수를 멱등하게 다시 실행해야 한다.

</details>

## 참고 자료

- [PostgreSQL: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html): 표준 현상과 PostgreSQL의 MVCC·serializable 구현이 제공하는 실제 보장을 설명한다.
- [PostgreSQL: MVCC Introduction](https://www.postgresql.org/docs/current/mvcc-intro.html): 여러 session이 일관된 데이터를 읽도록 version을 사용하는 공식 개요다.
- [PostgreSQL: Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html): dead tuple 회수와 장기 transaction이 cleanup에 미치는 영향을 확인한다.
- [MySQL 8.4: InnoDB Transaction Isolation Levels](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html): snapshot 생성과 record·gap lock이 isolation level별로 달라지는 제품 사례다.
- [MySQL 8.4: Deadlocks in InnoDB](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks.html): wait cycle, victim rollback과 애플리케이션 재시도 책임을 설명한다.
- [A Critique of ANSI SQL Isolation Levels](https://www.microsoft.com/en-us/research/publication/a-critique-of-ansi-sql-isolation-levels/): 현상 기반 표준 정의의 한계와 snapshot isolation 등 확장된 이상 현상을 분석한 논문이다.
