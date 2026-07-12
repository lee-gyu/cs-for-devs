# 11.8 분산 트랜잭션 — 여러 shard가 하나의 결정을 내리기까지

여러 shard의 원자적 commit은 모든 노드가 동시에 실행되는 환상을 만드는 문제가 아니다. 각 participant가 local 변경을 되돌릴 수 없는 준비 상태로 만든 뒤 하나의 durable decision을 따르게 하는 프로토콜이다. atomic commit은 commit/abort 일치만 결정하며, 읽기 snapshot·lock·serial order를 맞추는 분산 격리는 별도로 필요하다.

## 학습 목표

- local transaction, 분산 동시성 제어와 atomic commit의 책임을 구분한다.
- two-phase commit의 coordinator·participant 상태와 durable log 조건을 추적한다.
- prepared participant가 독자적으로 결정을 바꿀 수 없는 이유와 in-doubt·blocking을 설명한다.
- timeout·중복 메시지를 durable decision 조회와 멱등 상태 전이로 처리한다.
- cross-shard isolation·deadlock과 consensus-backed decision이 2PC에 더하는 보장을 판단한다.

## 배경: 주문은 저장됐는데 재고는 그대로다

주문 row는 고객 기준 shard A에, 재고 row는 상품 기준 shard B에 있다. 주문 확정은 다음 두 변경을 모두 수행해야 한다.

```text
shard A: order.status = 'CONFIRMED'
shard B: inventory.available -= quantity
```

A가 먼저 commit한 뒤 B가 실패하면 주문만 확정된다. B부터 commit하면 반대 상태가 가능하다. RPC를 두 번 호출하고 둘 다 성공했을 때 응답하는 것은 원자성을 만들지 못한다. 첫 RPC의 응답이 유실되면 성공 여부도 모호하다.

atomic commit protocol은 모든 participant가 commit하거나 모두 abort하도록 **결정의 일치**를 만든다. 그러나 두 transaction이 같은 재고를 읽는 순서, cross-shard snapshot과 write skew를 자동으로 해결하지는 않는다. 세 책임을 먼저 분리해야 한다.

## 세 개의 책임 경계

| 책임 | 질문 | 대표 메커니즘 |
|---|---|---|
| local transaction | 한 shard의 변경이 crash에도 원자적인가? | WAL, lock/MVCC, local commit |
| distributed concurrency control | 여러 shard read/write가 어떤 serial order·snapshot을 따르는가? | distributed lock, timestamp, validation, deadlock detection |
| atomic commit | participant가 commit/abort 결정을 일치시키는가? | 2PC, durable transaction record |

2PC가 성공해도 weak snapshot에서 write skew가 날 수 있다. 반대로 serializable한 conflict ordering을 계산했어도 한 participant만 commit하면 원자성이 깨진다. “분산 transaction을 지원한다”는 설명에서 isolation level, commit protocol과 failure recovery를 각각 확인한다.

## two-phase commit의 상태 모델

two-phase commit(2PC)에는 결정을 조정하는 coordinator C와 local resource를 소유한 participant P1·P2가 있다. transaction ID `T42`는 retry와 recovery 전 과정에서 동일해야 한다.

### phase 1: prepare와 vote

```text
C → P1,P2: PREPARE(T42)

P1: local 검증·lock 확보
    PREPARED(T42) durable log
    → C: YES

P2: local 검증 실패
    ABORT(T42) durable state
    → C: NO
```

participant가 YES라고 답하려면 이후 coordinator가 COMMIT을 선택해도 성공시킬 수 있어야 한다. 일반적으로 local update, undo/redo 정보와 prepared 상태를 durable하게 기록하고 필요한 lock/resource를 유지한다. prepare에 실패하거나 NO를 vote하면 abort할 수 있다.

### phase 2: decision

모든 participant가 YES를 vote했을 때 coordinator는 COMMIT을, 하나라도 NO이거나 prepare 전 정책상 timeout이면 ABORT를 고른다. 선택한 global decision을 durable하게 기록한 뒤 participant에 전파한다.

```text
C: DECISION(T42, COMMIT) durable
C → P1,P2: COMMIT(T42)

P1/P2: local commit, locks release
       → C: ACK
```

decision message가 일부 유실되어도 coordinator는 durable decision을 재전송할 수 있다. participant는 transaction ID로 중복 COMMIT을 이미 완료된 상태로 처리해야 한다.

### 상태 전이

```text
participant

ACTIVE ── prepare success + durable ──▶ PREPARED
  │                                      ├─ COMMIT decision ─▶ COMMITTED
  └─ local failure/ABORT ───────────────▶ ABORTED
                                         └─ ABORT decision ─▶ ABORTED
```

`PREPARED → ABORTED`는 local timeout만으로 임의 전이할 수 없다. global COMMIT decision이 이미 다른 participant에 전달됐을 수 있기 때문이다.

## durable 조건이 안전성을 만든다

### YES vote 전에 prepared를 durable하게 한다

P1이 memory에서만 준비하고 YES를 보낸 뒤 crash하면, coordinator는 모든 YES를 받아 COMMIT을 결정할 수 있다. P1이 restart 후 transaction을 모르면 다른 participant의 commit과 일치시킬 수 없다. 그래서 YES 이전에 prepared state와 local 복구 정보를 안정 저장해야 한다.

### decision 전파 전에 decision을 durable하게 한다

coordinator가 P1에 COMMIT을 보내고 durable record 없이 crash한 뒤 ABORT로 복구하면 P1과 P2의 결과가 갈린다. 전파 전 단일 결정이 복구 가능한 곳에 남아야 한다.

```text
safe ordering:
participant durable PREPARED → YES
coordinator durable DECISION → COMMIT/ABORT messages
```

local WAL과 replica quorum의 “durable” 정의는 배치에 따라 다르다. coordinator record가 한 process의 volatile memory에만 있으면 coordinator failover가 결정 가용성을 높이지 못한다.

## in-doubt와 blocking

participant가 PREPARED를 기록한 뒤 coordinator와 통신이 끊겼다고 하자. participant는 다음 두 history를 구분하지 못한다.

```text
history A: coordinator가 COMMIT을 durable하게 결정했지만 message 유실
history B: coordinator가 아직 결정하지 못하고 crash
```

timeout은 두 경우 모두 발생한다. 따라서 timeout은 실패 판정이 아니라 **결정을 모른다는 관찰**이다. participant는 coordinator recovery, decision service나 다른 protocol이 허용한 termination 절차에서 durable decision을 조회해야 한다. 그동안 lock·prepared version을 유지하면 다른 transaction이 막힌다. 이것이 in-doubt transaction과 classic 2PC blocking이다.

준비 상태를 오래 유지할수록 다음 비용이 커진다.

- row/range lock과 write conflict
- MVCC old version·undo·WAL retention
- connection과 transaction metadata
- schema change·vacuum·shard migration 방해

prepared transaction 수뿐 아니라 oldest prepared age, 보유 key/range와 blocking request를 관찰한다.

## timeout과 중복 메시지

### coordinator의 prepare timeout

participant가 아직 YES를 durable하게 vote하지 않았음을 coordinator가 확실히 안다면 ABORT를 결정할 수 있다. 하지만 YES response만 유실됐을 수 있으므로 protocol의 durable participant state와 recovery 규칙을 따라야 한다. timeout 값만으로 상대 state를 추측하지 않는다.

### participant의 decision timeout

PREPARED participant는 독자 abort하지 않고 transaction ID로 authoritative decision을 찾는다. 운영자가 “오래됐으니 rollback”을 선택하면 이미 commit한 다른 participant와 불일치할 수 있다. 수동 해결에도 coordinator record, participant vote와 업무 상태를 확인하는 runbook이 필요하다.

### 멱등 상태 전이

network는 duplicate·reorder를 만들 수 있다. 메시지는 최소 다음 규칙을 가져야 한다.

```text
PREPARE(T42) after PREPARED(T42) → 같은 vote 반환
COMMIT(T42) after COMMITTED(T42) → success/ACK
ABORT(T42) after ABORTED(T42)    → success/ACK
ABORT(T42) after COMMITTED(T42)  → conflict, 상태를 바꾸지 않음
```

payload가 같은 transaction ID로 달라지면 재사용 오류로 거절해야 한다. “멱등 API”는 결과 cache가 아니라 durable transaction state machine이다.

## 격리와 atomic commit은 별개다

### cross-shard snapshot

P1에서 position/time 100, P2에서 120을 읽으면 실제로 함께 존재한 적 없는 상태를 조합할 수 있다. consistent snapshot은 timestamp, read position 또는 transaction metadata를 shard 사이에 조정해야 한다. clock만 읽는다고 충분하지 않으며 timestamp ordering의 uncertainty·validation 계약을 확인한다.

### distributed write conflict

각 participant의 local lock은 그 shard 충돌을 막지만 global serialization graph는 여러 shard edge를 포함한다.

```text
T1 holds A:x, waits B:y
T2 holds B:y, waits A:x
```

각 shard만 보면 local cycle이 없을 수 있다. global wait-for edge를 모으는 detector, timeout+victim policy 또는 timestamp ordering이 필요하다. victim을 고르면 아직 prepare 전인지 prepared인지에 따라 abort 가능 경계가 다르다.

### commit timestamp와 visibility

모든 participant가 COMMIT을 결정해도 독자가 서로 다른 시점에 provisional write를 볼 수 있으면 partial visibility가 생긴다. transaction record 상태를 조회해 intent를 해석하거나 공통 commit timestamp 이후 노출하는 등 atomic visibility가 필요하다. background cleanup이 늦어도 decision record가 authoritative하면 reader가 committed로 해석할 수 있는 설계가 있다.

## consensus와 2PC의 결합

2PC와 consensus는 같은 문제를 풀지 않는다.

- 2PC는 서로 다른 participant의 local transaction을 하나의 commit/abort에 묶는다.
- consensus는 replica들이 하나의 log/value 순서에 합의해 node failure에도 상태를 가용하게 만든다.

coordinator decision record를 consensus-replicated group에 두면 한 coordinator process가 죽어도 quorum이 decision을 제공할 수 있다. 각 participant의 local prepared state도 복제 group에 durable하게 둘 수 있다.

```text
2PC participant P1 = replicated shard group
2PC participant P2 = replicated shard group
coordinator decision = replicated transaction record/group
```

이 결합은 classic single-coordinator failure의 blocking을 줄이지만 network partition에서 quorum을 잃은 group은 여전히 진행하지 못할 수 있다. 두 phase의 cross-group network·durable replication 비용도 사라지지 않는다. Spanner처럼 participant Paxos group 위에 2PC를 두거나, CockroachDB처럼 transaction record와 replicated intents를 사용하는 사례는 세부 최적화가 달라도 이 책임 분리를 보여 준다.

## transaction timeline 진단

주문 T42가 shard A·B를 건드렸는데 p99가 3초로 증가했다고 하자.

| 시각 | coordinator | shard A | shard B |
|---|---|---|---|
| 0ms | ACTIVE | local write | local write |
| 20ms | PREPARE send | prepare 15ms, YES | lock wait 2.8s |
| 2820ms | all YES | PREPARED, lock held | PREPARED |
| 2830ms | COMMIT durable | waiting decision | waiting decision |
| 2870ms | ACK complete | COMMITTED | COMMITTED |

느린 구간은 decision flush가 아니라 B의 prepare 전 lock wait다. `2PC가 느리다`는 결론보다 다음을 분리한다.

```text
execution/read phase
local lock/validation
prepare network
participant prepared log/replication
coordinator decision log/replication
decision delivery + local commit
cleanup/intents resolution
```

transaction ID 하나로 coordinator state, participant state, lock owner, log/term·timestamp와 retry를 연결한다. participant별 평균만 보지 않고 slowest participant와 fan-out 수를 본다.

## 장애 상태 판독

| 관찰 | 안전한 해석·다음 행동 |
|---|---|
| ACTIVE, durable YES 없음 | protocol이 허용하면 abort 가능 |
| PREPARED, decision 미확인 | in-doubt, authoritative decision 조회 |
| durable COMMIT decision | 모든 participant에 commit 재전송 |
| durable ABORT decision | 모든 participant에 abort 재전송 |
| participant COMMITTED, coordinator record 없음 | 심각한 불변식 위반 또는 잘못된 record 조회, 임의 rollback 금지 |

“coordinator가 안 보이니 abort”나 “한 shard에 row가 있으니 모두 commit” 같은 추론은 충분하지 않다. prepared/decision의 durable evidence를 찾는다.

## 실무 관점

### cross-shard transaction을 무조건 제거하지 않는다

강한 원자성이 업무 핵심이고 DBMS가 검증된 protocol을 제공한다면 application에서 불완전한 dual write를 재구현하는 것보다 안전하다. 다만 participant 수, geography, contention과 retry budget을 측정하고 자주 함께 쓰는 데이터를 co-locate할 수 있는지 먼저 본다.

### prepared transaction을 일반 connection transaction처럼 다루지 않는다

session이 끝나도 durable prepared state와 lock이 남을 수 있다. owner 없는 prepared entry를 자동 rollback하면 안전성을 깨뜨린다. transaction manager와 reconciliation이 없는 환경에서는 직접 2PC primitive를 사용하지 않는다.

### Saga·outbox와 혼합해 설명하지 않는다

Saga의 보상은 이미 commit한 업무 효과를 새 transaction으로 되돌리는 workflow이고 2PC rollback과 같은 원자적 abort가 아니다. 이 문서는 DBMS 내부 atomic commit에 한정하며 서비스 workflow 설계는 범위 밖이다.

## 정리

- local transaction, distributed isolation과 atomic commit은 서로 다른 책임이다.
- 2PC participant는 YES 전에 PREPARED를, coordinator는 전파 전에 DECISION을 durable하게 기록한다.
- prepared participant는 global decision이 이미 commit일 수 있어 timeout만으로 독자 abort할 수 없다.
- transaction ID와 멱등 상태 전이는 duplicate·retry에서도 한 결정을 유지한다.
- cross-shard snapshot·deadlock·visibility는 2PC 외에 분산 동시성 제어가 해결해야 한다.
- consensus-backed transaction record와 replicated participant는 결정 가용성을 높이지만 cross-group coordination과 quorum 경계를 없애지 않는다.

## 확인 문제

1. participant가 YES를 보낸 뒤 prepared record를 flush하기 전에 crash했다. 어떤 안전성 문제가 생기는가?
2. prepared participant가 30초 timeout 후 스스로 abort하면 안 되는 이유는 무엇인가?
3. 모든 participant가 2PC로 commit했지만 두 shard의 서로 다른 snapshot을 읽어 불변식이 깨졌다. 무엇이 빠졌는가?
4. coordinator process를 세 개로 복제하면 2PC blocking이 자동으로 사라지는가?

<details>
<summary>정답과 해설</summary>

1. coordinator가 모든 YES를 받고 COMMIT을 결정할 수 있는데 restart한 participant는 T를 모른다. 다른 participant와 같은 결정을 실행할 수 없으므로 YES 전에 prepared state와 local 복구 정보를 durable하게 해야 한다.
2. coordinator가 이미 COMMIT을 durable하게 기록하고 다른 participant에 전달했지만 message가 유실됐을 수 있다. timeout은 결정을 알려 주지 않으므로 authoritative decision을 조회해야 한다.
3. atomic commit은 commit/abort 일치만 제공한다. cross-shard consistent snapshot과 serializable conflict ordering을 담당할 distributed concurrency control이 필요하다.
4. process 복제만 하고 decision state가 consensus 등으로 한 값에 합의·durable하지 않으면 서로 다른 결정을 낼 수 있다. quorum을 잃은 partition에서는 progress도 여전히 막힐 수 있다.

</details>

## 참고 자료

- [PostgreSQL: `PREPARE TRANSACTION`](https://www.postgresql.org/docs/current/sql-prepare-transaction.html): durable prepared state, lock 유지와 외부 transaction manager 책임을 보여 주는 2PC primitive다.
- [X/Open Distributed Transaction Processing: XA Specification](https://pubs.opengroup.org/onlinepubs/009680699/toc.pdf): transaction manager와 resource manager 사이의 prepare·commit 계약을 정의한다.
- [Consensus on Transaction Commit](https://lamport.azurewebsites.net/video/consensus-on-transaction-commit.pdf): 2PC와 Paxos Commit의 safety·availability 관계를 분석한다.
- [Spanner: Google’s Globally-Distributed Database](https://research.google/pubs/spanner-googles-globally-distributed-database/): replicated participant group 위의 2PC와 timestamp 기반 transaction을 설명한다.
- [CockroachDB: Transaction Layer](https://www.cockroachlabs.com/docs/stable/architecture/transaction-layer/): replicated intent와 authoritative transaction record로 distributed atomic visibility를 구현하는 다른 사례다.
