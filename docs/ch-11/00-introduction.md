# 11. 데이터베이스 시스템 내부와 실행 진단 — SQL을 비용과 보장의 경로로 읽는다

데이터베이스 문제를 진단하려면 SQL 문장만 보지 않고 요청이 파서·옵티마이저·실행기·버퍼·페이지·로그를 통과하는 경로를 추적해야 한다. 이 챕터는 결과의 정확성, 자원 비용, 동시 실행의 격리, 커밋의 내구성을 서로 다른 계약으로 분리하고 각 계약을 실행 계획과 내부 상태라는 증거로 판단한다.

## 학습 목표

- SQL 요청이 논리 계획에서 물리 연산자와 페이지 접근을 거쳐 결과를 만드는 경로를 설명한다.
- 레코드·페이지·버퍼·인덱스와 통계·비용 모델을 연결해 지배적인 읽기·쓰기 비용을 예측한다.
- 락·MVCC·WAL·checkpoint가 격리와 내구성 계약을 조립하는 방식을 구분한다.
- 복제·sharding·분산 commit이 읽기 일관성, 가용성, 지연과 장애 복구 경계를 바꾸는 이유를 판단한다.
- 워크로드와 보장에 맞는 관찰 증거를 고르고 변경 전후의 새 비용까지 검증한다.

## 배경: 인덱스를 추가했는데 왜 주문 확정이 느려졌는가

[챕터 0의 주문 확정 API](../ch-0/02-cs-in-practice.md)는 처음에는 빠르게 동작했다. 주문 데이터가 커진 뒤 특정 고객군의 최근 주문을 찾는 조회가 느려지자 팀은 `customer_id, created_at` 인덱스를 추가했다. 조회 지연은 줄었지만 판매 이벤트가 시작되자 주문 확정의 p99가 커지고 일부 요청은 lock timeout을 만났다. 데이터베이스 CPU는 포화되지 않았고 캐시 적중률도 높았다.

이 현상에는 서로 다른 원인이 겹칠 수 있다.

- 보조 인덱스를 갱신하며 더 많은 페이지를 수정하고 page split을 일으킨다.
- 여러 세션이 같은 고객이나 인덱스 영역을 갱신해 락을 기다린다.
- dirty page가 빠르게 늘어 background flush가 쓰기 I/O를 압박한다.
- 상태와 고객군이 강하게 상관되지만 통계가 이를 표현하지 못해 잘못된 접근 경로를 고른다.
- 트랜잭션이 애플리케이션의 원격 호출까지 포함해 락과 오래된 version을 오래 유지한다.

“인덱스가 사용됐는가”, “CPU가 높은가” 같은 단일 질문으로는 이 가설들을 구분할 수 없다. SQL의 정상 결과가 같아도 읽은 페이지 수, 수정한 구조, 기다린 자원, 로그를 안정 저장한 시점은 다를 수 있다. 데이터베이스 내부를 배우는 목적은 구현 이름을 외우는 것이 아니라 이 차이를 예측하고 증거로 좁히는 데 있다.

## 하나의 SQL 요청이 지나가는 경로

다음 지도는 관계형 DBMS의 전형적인 책임 분리를 단순화한 것이다. 제품마다 경계와 결합 방식은 다르지만 진단 질문은 이 경로에 대응시킬 수 있다.

```text
SQL text + parameters
        │
        ▼
parse ─ bind ─ rewrite
        │
        ▼
logical plan
        │  통계 · 카디널리티 · 비용 모델
        ▼
cost-based optimization
        │
        ▼
physical plan
scan · join · sort · aggregate
        │
        ▼
access path ─ index / heap / sorted run
        │
        ▼
buffer manager ─ page table · pin · dirty · eviction
        │
        ▼
pages · files · storage

transaction manager  ─ 가시성 · 락 · 스케줄
recovery manager     ─ WAL · commit · checkpoint · redo/undo
replication/sharding ─ log position · routing · distributed decision
```

### parse·bind·rewrite는 의미를 확정한다

파싱(parse)은 문자열이 문법에 맞는 구조인지 확인한다. 바인딩(binding)은 테이블·열·함수 이름을 실제 객체와 타입에 연결하고 접근 권한 같은 문맥을 확인한다. 재작성(rewrite)은 view 확장이나 술어 단순화처럼 의미를 보존하는 동치 변환을 적용할 수 있다. 이 단계의 출력은 대개 **무엇을 계산할지** 표현하며 아직 어떤 인덱스와 조인 알고리즘을 쓸지 확정하지 않는다.

### optimizer는 가능한 구현 중 비용이 낮다고 추정한 것을 고른다

같은 논리 연산도 full scan과 index scan, nested-loop·hash·merge join 등 여러 물리 구현을 가질 수 있다. 비용 기반 옵티마이저(cost-based optimizer)는 통계로 중간 결과의 행 수를 추정하고 CPU, 페이지 접근, 메모리와 통신을 추상화한 비용을 비교한다. 이것은 미래 실행 시간을 정확히 예언하는 모델이 아니다. 분포가 치우치거나 열 사이 상관관계를 놓치면 작은 행 수 오차가 조인 순서 뒤쪽에서 크게 증폭될 수 있다.

### executor는 연산자를 실행하며 자원을 소비한다

실행기(executor)는 선택된 scan·join·sort·aggregate 연산자를 연결해 행 또는 벡터를 생산한다. 입력이 메모리 예산을 넘으면 sort나 hash가 임시 저장소로 spill할 수 있고, 같은 내부 노드가 바깥쪽 입력마다 반복되어 `rows × loops`만큼 일을 할 수 있다. 계획의 노드 이름보다 입력 크기, 반복 수, 페이지 접근과 spill을 함께 봐야 하는 이유다.

### buffer manager는 논리적 페이지와 메모리 프레임을 연결한다

연산자는 보통 파일 offset을 직접 읽지 않고 버퍼 관리자(buffer manager)에 페이지를 요청한다. 관리자는 페이지가 메모리에 있는지 찾고, 없으면 프레임을 확보해 읽으며, 사용 중인 페이지가 축출되지 않게 pin한다. 수정된 dirty page를 내보내려면 복구 규칙에 따라 관련 로그가 먼저 안정 저장되어야 할 수 있다. 따라서 높은 hit ratio만으로 지연이 낮다고 결론 내릴 수 없다. hit한 페이지의 latch나 lock을 기다릴 수 있고, dirty eviction과 flush가 쓰기 경로를 막을 수도 있다.

## 네 가지 계약을 분리한다

주문 확정이 “성공했다”는 말에는 최소 네 계약이 섞여 있다.

| 계약 | 질문 | 주된 구성 요소 | 대표 증거 |
|---|---|---|---|
| 논리적 정확성 | 반환된 행과 최종 상태가 질의·제약을 만족하는가? | parser, executor, constraint | 결과 집합, 제약 위반, 상태 불변식 |
| 자원 비용 | 허용한 시간·메모리·I/O 안에 끝나는가? | optimizer, operator, index, buffer | 추정/실제 행, loops, page·buffer, spill, latency |
| 동시성·격리 | 다른 트랜잭션과 섞여도 허용한 이상 현상만 나타나는가? | lock, MVCC, scheduler | wait graph, snapshot/version, transaction timeline |
| 내구성·복구 | 성공을 알린 뒤 crash가 나도 약속한 상태를 복원하는가? | WAL, fsync, checkpoint, recovery | log position, flush 시점, redo/undo, recovery 결과 |

한 계약의 증거로 다른 계약을 증명하면 안 된다. `COMMIT`이 빠르게 반환됐다는 사실만으로 replica에서 즉시 읽을 수 있음을 보장하지 않는다. `EXPLAIN`의 비용이 낮다는 사실은 실제 행 수나 wall-clock time을 측정한 결과가 아니다. serializable이라는 격리 이름도 제품이 어떤 충돌을 감지하고 어떤 재시도 책임을 요구하는지 읽기 전에는 충분한 설명이 아니다.

## 공통 주문 워크로드

본문은 다음 관계를 가진 합성 워크로드를 반복해서 사용한다.

```text
customers(customer_id, segment, region, ...)
orders(order_id, customer_id, status, created_at, total_amount, ...)
order_items(order_id, product_id, quantity, unit_price, ...)
inventory(product_id, available_quantity, version, ...)
```

핵심 불변식과 접근 패턴을 먼저 고정한다.

- 하나의 주문 ID에는 주문이 최대 하나 존재한다.
- 확정된 주문 수량만큼 재고를 차감하되 가용 재고는 음수가 되지 않는다.
- 고객별 최근 주문과 상태별 미처리 주문 조회가 빈번하다.
- 판매 이벤트 동안 특정 상품과 고객군에 쓰기가 집중된다.
- 성공 응답을 보낸 주문은 crash 뒤에도 복원되어야 한다.

이후 문서에서는 한 번에 한 조건을 바꾼다. 행 폭과 작업 집합이 커지고, 분포에 상관관계가 생기며, 인덱스가 추가되고, 두 트랜잭션이 같은 재고를 갱신한다. 이어서 crash, replica lag, hot shard와 cross-shard commit을 주입한다. 그래야 결과 변화가 어느 가정에서 왔는지 설명할 수 있다.

## 진단 판단 루프

### 1. 계약과 워크로드를 먼저 쓴다

“쿼리를 빠르게 한다” 대신 p99 지연, 동시 세션 수, 데이터 분포와 허용 가능한 결과를 적는다. 읽기 전용 분석 쿼리와 재고 차감 트랜잭션은 같은 데이터에 접근해도 필요한 격리와 지연 목표가 다르다.

### 2. 내부 비용을 예측한다

측정 전에 어떤 접근 경로와 조인 순서를 예상하는지, 몇 행과 페이지를 읽을지, 어느 연산자가 메모리를 넘을지 적는다. 정확한 숫자를 모르면 크기 순서와 지배 비용이라도 명시한다. 예측이 있어야 관찰 결과가 단순한 숫자 수집이 아니라 모델의 검증이 된다.

### 3. 원인에 가까운 증거를 모은다

wall-clock time만 보지 않고 다음 축을 가능한 범위에서 모은다.

- 접근 경로와 조인 순서·방식
- 노드별 추정 행과 실제 행, 반복 횟수
- page read, buffer hit, dirty page와 flush
- sort/hash spill과 임시 데이터 크기
- lock·latch·I/O wait와 대기 상대
- WAL·commit·replica의 send/write/flush/apply 위치
- shard별 bytes·QPS·latency와 query fan-out

제품이 제공하지 않는 지표는 비슷해 보이는 값으로 채우지 않고 `N/A`로 남긴다. 예를 들어 SQLite의 `EXPLAIN QUERY PLAN` 출력에 PostgreSQL의 buffer counter와 같은 의미를 부여할 수 없다.

### 4. 예측과 다른 첫 지점을 찾는다

실제 행 수가 추정부터 크게 다르면 인덱스를 무작정 추가하기 전에 통계와 데이터 관계를 본다. 행 수는 맞는데 시간이 길면 페이지 접근, spill, wait 또는 storage latency를 본다. 실행은 끝났지만 commit이 느리면 WAL flush와 동기 replica acknowledgment 경로를 분리한다.

### 5. 한 변수를 바꾸고 새 비용을 검증한다

복합 인덱스가 읽는 페이지를 줄였으면 쓰기 시 수정 페이지, 로그량과 공간도 비교한다. 트랜잭션을 짧게 만들었으면 실패 시 재시도와 상태 전이 계약이 유지되는지 확인한다. replica read로 primary 부하를 줄였으면 stale read가 허용되는 경로인지 검증한다.

## 챕터 지도

1. [저장 배치와 버퍼 관리](./01-storage-layout-and-buffer-management.md)는 행이 페이지와 메모리 프레임에 놓이는 과정을 추적한다.
2. [인덱스와 스토리지 엔진](./02-indexes-and-storage-engines.md)은 B+트리·hash·LSM이 만드는 읽기·쓰기·공간 증폭을 비교한다.
3. [질의 처리와 실행 계획](./03-query-processing-and-execution-plans.md)은 SQL에서 물리 연산자로 내려가고 오판을 진단하는 법을 다룬다.
4. [트랜잭션과 동시성 제어](./04-transactions-and-concurrency-control.md)는 lock·MVCC·격리 이상을 실행 순서로 해석한다.
5. [내구성과 복구](./05-durability-and-recovery.md)는 WAL·checkpoint·redo/undo와 성공 응답의 경계를 다룬다.
6. [데이터베이스 복제](./06-database-replication.md)는 로그가 replica 상태가 되는 시점과 failover 계약을 추적한다.
7. [sharding과 데이터 배치](./07-sharding-and-data-placement.md)는 routing·co-location·fan-out·resharding 비용을 판단한다.
8. [분산 트랜잭션](./08-distributed-transactions.md)은 여러 shard의 격리와 atomic commit을 구분한다.
9. [데이터베이스 패러다임과 선택](./09-database-paradigms-and-selection.md)은 앞선 비용 모델을 저장소 계열 선택에 적용한다.

부분 실패·합의·일관성 모델의 이론은 아직 집필 전인 챕터 10에, 파일 시스템과 동기 I/O는 [챕터 8](../ch-8/00-introduction.md)에, DB 지표를 SLO로 운영하는 방법은 챕터 14에 위임한다.

## 실무 관점: 세 가지 첫 질문

장애 상황에서 먼저 “데이터베이스가 느리다”라고 결론 내리지 않는다.

### 느린가

CPU 실행, 페이지 I/O, spill 또는 로그 flush처럼 실제 일을 수행하는 시간이 늘었는지 본다. 실행 계획과 자원 counter가 출발점이다.

### 기다리는가

락·latch·buffer pin, connection pool, I/O queue 또는 동기 replica를 기다리는지 본다. 낮은 CPU는 문제가 없다는 증거가 아니라 기다림 가설과 일치할 수 있다.

### 디스크와 다른 노드에 어디까지 남았는가

local WAL append, durable flush, replica receive·flush·apply와 client acknowledgment를 한 timeline에 둔다. 성공 응답, local durability와 replica visibility는 서로 다른 시점일 수 있다.

이 세 질문은 완전한 진단 절차가 아니지만 저장·실행·동시성·복구 중 어느 증거를 먼저 볼지 정해 준다.

## 정리

- SQL 요청은 의미 분석, 최적화, 물리 실행, 버퍼와 저장 장치를 통과한다.
- 논리적 정확성, 자원 비용, 동시성·격리와 내구성은 별도 계약이며 서로 다른 증거가 필요하다.
- 비용 기반 선택은 통계와 모델에 의존하므로 추정과 실제의 차이가 진단의 핵심 단서다.
- buffer hit, 낮은 CPU, 빠른 `COMMIT` 같은 단일 지표로 전체 경로를 판정할 수 없다.
- 좋은 변경은 증상을 줄이는 데서 끝나지 않고 읽기·쓰기·공간·대기·복구에 새로 생긴 비용을 같은 증거로 검증한다.

## 확인 문제

1. 주문 조회에 인덱스를 추가한 뒤 조회 p50은 줄었지만 주문 확정 p99와 WAL 생성량이 늘었다. 어떤 계약과 증거를 분리해 조사해야 하는가?
2. 실행 계획의 추정 행은 실제 행과 거의 같지만 hash join이 임시 저장소로 spill했고 wall-clock time이 길다. 통계 갱신보다 먼저 확인할 것은 무엇인가?
3. primary에서 `COMMIT` 성공 직후 replica 조회가 주문을 찾지 못했다. 이것이 곧 내구성 위반을 뜻하지 않는 이유는 무엇인가?

<details>
<summary>정답과 해설</summary>

1. 조회의 자원 비용과 쓰기의 자원·동시성 비용을 따로 본다. 조회 page read 감소뿐 아니라 인덱스 수정 페이지, page split, dirty flush, WAL bytes, lock wait와 트랜잭션 시간을 변경 전후로 비교한다. 결과 정확성이 같아도 쓰기 증폭과 대기가 늘 수 있다.
2. 입력 행 수가 맞다면 hash table의 실제 row width, 연산자 메모리 예산, 동시 실행 수, batch 수와 임시 I/O를 확인한다. 카디널리티가 아니라 메모리 크기 추정이나 가용 예산이 경계를 넘었을 수 있다.
3. local commit durability와 replica apply visibility는 다른 계약이다. 비동기 복제에서는 local WAL이 durable한 뒤 클라이언트에 응답해도 replica가 아직 로그를 받거나 적용하지 않았을 수 있다. 어떤 log position까지 flush·apply했는지와 읽기 라우팅 정책을 확인해야 한다.

</details>

## 참고 자료

- [Architecture of a Database System](https://doi.org/10.1561/1900000002): query processor, storage manager, transaction·recovery와 shared component로 DBMS 책임을 조망하는 기준 논문이다.
- [PostgreSQL: Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html): 비용 추정, 실제 행·시간과 실행 계획을 구분해 읽는 제품별 관찰 사례다.
- [SQLite: Query Planning](https://www.sqlite.org/queryplanner.html): 작은 엔진에서도 여러 접근 경로의 비용을 비교해 계획을 고르는 과정을 확인할 수 있다.
- [MySQL 8.4: InnoDB Buffer Pool](https://dev.mysql.com/doc/refman/8.4/en/innodb-buffer-pool.html): buffer page, LRU 변형, dirty page와 read-ahead를 관찰하는 제품별 사례다.
