# 11.6 데이터베이스 복제 — 한 로그를 여러 노드의 상태로 만든다

복제는 데이터 사본을 만드는 한 번의 작업이 아니다. 기준 snapshot 이후의 변경 로그를 계속 전달하고 적용해 여러 노드의 상태를 전진시키는 프로토콜이다. commit 응답, replica 내구성, query visibility와 failover 안전성은 서로 다른 위치에서 성립하므로 하나의 “replication lag” 숫자로 판단할 수 없다.

## 학습 목표

- 물리·논리 복제 단위가 호환성·대역폭·재생 비용을 교환하는 방식을 비교한다.
- snapshot/bootstrap과 log catch-up으로 새 replica가 일관된 기준 상태를 만드는 과정을 설명한다.
- primary append부터 replica receive·durable write·apply까지 log position을 추적한다.
- 동기·비동기 acknowledgment가 commit latency, 가용성과 데이터 손실 경계를 바꾸는 이유를 판단한다.
- stale read와 failover 문제를 session guarantee·fencing·timeline 증거로 진단한다.

## 배경: 커밋한 주문이 replica에는 없다

주문 확정 API는 primary에서 `COMMIT` 성공을 받은 직후 고객 상세 화면을 read replica로 보냈다. 상세 화면은 방금 만든 주문을 찾지 못했다. 수 초 뒤 새로 고치자 주문이 보였다.

primary의 local durability가 깨진 것은 아닐 수 있다. 비동기 replica가 다음 네 단계를 아직 끝내지 않았을 수 있다.

```text
primary WAL append/flush
        │ send
        ▼
replica receive
        │ write/flush
        ▼
replica durable log
        │ apply/replay
        ▼
query-visible state
```

network가 빠른데도 apply가 느릴 수 있고, replica가 log를 durable하게 보관해도 query에는 아직 보이지 않을 수 있다. 따라서 “replication lag 2초”라는 값은 position 차이인지, wall-clock 추정인지, receive·flush·apply 중 어느 단계인지부터 확인해야 한다.

## 복제의 단위

### 물리 복제

물리 복제(physical replication)는 WAL·page 변경처럼 storage engine의 낮은 수준 기록을 전달한다. primary와 동일한 page layout과 recovery 코드를 이용해 재생하므로 변경을 충실하게 복제하기 쉽고 대량 transaction도 page-level log 흐름으로 처리한다.

대신 파일 형식·엔진 버전·플랫폼 호환성에 더 강하게 묶일 수 있다. page 전체 이미지나 vacuum·index 변경 같은 물리 작업이 대역폭과 replica I/O를 소비할 수 있다. query가 원하는 table·row 의미와 log record가 직접 대응하지 않을 수도 있다.

### 논리 복제

논리 복제(logical replication)는 table·row·key 변경이나 논리 operation을 전달한다. 일부 table만 선택하거나 schema가 다른 consumer로 변환하고 version 간 호환 범위를 넓힐 수 있다.

하지만 row identity, schema evolution, statement 의미와 apply conflict를 다뤄야 한다. 같은 결과를 만드는 대량 update가 행별 event를 많이 만들 수 있고 DDL·sequence·대형 객체 지원 범위도 제품마다 다르다. “논리적”이 곧 제품 중립이거나 모든 변경을 복제한다는 뜻은 아니다.

| 축 | 물리 복제의 경향 | 논리 복제의 경향 |
|---|---|---|
| 기록 단위 | WAL·page/storage operation | row·key·transaction change |
| 충실도 | 엔진 상태 재현에 강함 | 선택·변환에 강함 |
| 호환성 | storage format에 밀접 | schema·decoder 계약에 밀접 |
| 대역폭 | 물리 maintenance도 포함 가능 | 넓은 row update·event overhead 가능 |
| apply | recovery와 유사 | constraint·conflict·schema 처리 |

제품별 구현은 두 극단을 섞을 수 있다. MySQL row/statement/mixed binary log, PostgreSQL physical WAL streaming과 logical decoding은 각각 다른 계약이므로 이름만으로 동일시하지 않는다.

## bootstrap: 기준 상태와 로그를 한 점에서 잇는다

새 replica는 현재 data file을 임의로 복사한 뒤 최신 log만 받으면 안 된다. copy 중 primary가 바뀌므로 data snapshot과 log 시작 위치가 일관된 경계를 공유해야 한다.

```text
primary log: ─── LSN 800 ─── 900 ─── 1000 ───▶
                         │
                    snapshot S
                    base position=900
                         │ copy
                         ▼
replica: restore S → replay log after 900 → catch up
```

전형적인 절차는 다음과 같다.

1. 일관된 snapshot과 그에 대응하는 log position을 얻는다.
2. snapshot을 replica에 전송·복원한다.
3. snapshot 이후 log를 보존해 두었다가 전달한다.
4. replica가 backlog를 apply해 current position을 따라잡는다.
5. 검증 후 읽기나 failover 후보로 등록한다.

copy 시간이 길면 보존할 log가 커진다. replication slot·retention이 consumer를 위해 old log 삭제를 막으면 primary disk를 채울 수 있다. 반대로 retention이 부족하면 replica가 필요한 log를 잃어 bootstrap부터 다시 해야 한다. replica 지연은 replica만의 용량 문제가 아니다.

## position으로 복제 상태를 읽는다

용어는 제품마다 다르지만 공통 position을 다음처럼 정규화할 수 있다.

```text
P_local_flush : primary에서 durable한 마지막 log
R_receive     : replica가 받은 마지막 log
R_flush       : replica에서 durable한 마지막 log
R_apply       : replica state에 적용한 마지막 log
```

정상적으로 한 stream의 prefix를 처리한다면 대략 다음 관계를 기대한다.

```text
R_apply ≤ R_flush ≤ R_receive ≤ P_sent ≤ P_local_flush/current
```

parallel apply, transaction boundary와 out-of-order worker 때문에 단일 scalar가 완전한 상태를 표현하지 못할 수 있다. 제품이 표시하는 low-water mark와 개별 worker 완료 위치를 구분한다.

### lag을 구간으로 분해한다

| 구간 | 가능한 원인 | 필요한 증거 |
|---|---|---|
| primary → receive | network·sender backlog | sent/receive position, bytes/s, RTT·queue |
| receive → flush | replica storage write | receive/flush position, fsync latency, device queue |
| flush → apply | replay CPU·lock·long transaction | flush/apply position, apply rate, conflict·wait |
| apply → query visibility | snapshot·read routing·transaction boundary | query snapshot, endpoint, visible commit position |

초 단위 lag은 write가 없는 idle period에 오래된 timestamp를 기준으로 과장되거나, clock skew 영향을 받을 수 있다. position bytes도 transaction 크기와 log encoding에 따라 사용자 row 수와 선형 대응하지 않는다. position과 처리율, oldest unapplied transaction의 commit time을 함께 본다.

## acknowledgment 정책

### 비동기 commit

primary가 local durability를 만족하면 replica receipt를 기다리지 않고 응답한다.

```text
client ← ACK after primary local flush
                    │
                    └── send later/in parallel ──▶ replica
```

replica network·storage 장애가 primary commit latency에 직접 들어오지 않아 가용성과 지연에 유리하다. 그러나 primary가 복제되지 않은 committed log와 함께 영구 손실되면 acknowledged transaction을 새 primary에서 잃을 수 있다.

### 동기 commit

응답 전에 하나 이상의 replica가 특정 단계까지 도달하기를 기다린다. “동기”만으로 어느 단계를 뜻하는지 알 수 없다.

- receive: replica memory/process가 받음
- write: OS/storage 경로에 기록
- durable flush: replica의 약속한 stable storage에 도달
- apply/remote visibility: replica query state에 반영

더 강한 단계는 손실·read-after-write 경계를 줄이지만 replica의 network·storage·apply tail latency를 commit 경로에 넣는다. 필요한 동기 replica 수가 부족할 때 commit을 block할지 async로 degrade할지도 가용성 계약이다.

```text
commit latency ≈ local work + local flush
               + selected replica quorum/standby acknowledgment tail
```

동기 복제가 자동으로 전체 시스템의 serializable 격리를 만들지는 않는다. 이는 commit durability/visibility의 한 축이며 동시성 제어는 별도다.

## replica read와 session guarantee

eventual convergence만으로 사용자 흐름이 충분하지 않을 수 있다.

### read-your-writes

한 session이 완료한 write 이후에는 그 write 이상 position의 replica에서 읽어야 한다. 구현 선택은 다음과 같다.

- 일정 시간 primary에 sticky routing한다.
- commit position token을 client/session에 전달하고 `R_apply ≥ token`인 replica를 고른다.
- replica가 따라올 때까지 기다리거나 primary로 fallback한다.
- commit 자체가 remote apply까지 기다리는 강한 계약을 사용한다.

고정 sleep은 부하에 따라 너무 길거나 짧고 보장을 증명하지 못한다.

### monotonic read

한 session의 후속 read가 이전에 본 position보다 뒤로 가지 않게 한다. load balancer가 replica A에서 position 1200을 본 뒤 lagging replica B의 1150으로 보내면 과거 상태로 돌아간 것처럼 보인다. 마지막 관찰 token 이상인 replica를 선택하거나 session affinity를 사용한다.

### bounded staleness

“최대 5초 stale”은 측정 clock, transaction commit time과 apply watermark 정의가 필요하다. position 기반 보장을 wall-clock으로 변환할 수 있는 제품 계약을 확인한다. analytics·검색에는 허용 가능해도 주문 직후 확인이나 authorization에는 부적합할 수 있다.

## failover와 fencing

replica 중 가장 최신인 노드를 새 primary로 고르는 것만으로 충분하지 않다. 이전 primary가 network partition으로 control plane과 끊겼지만 client 일부와 연결되어 계속 write를 받으면 두 primary가 서로 다른 history를 만든다.

```text
clients A ─▶ old primary P1  (아직 자신이 primary라고 믿음)

control plane promotes P2 ◀─ clients B

P1 history: ... x y
P2 history: ... x z
```

fencing은 오래된 primary가 write를 수행하거나 storage에 접근하지 못하게 한다. epoch/term, lease, storage fence, process termination과 routing 인증 같은 방식이 있으며 clock·partial failure 가정이 다르다. failover 안전성은 다음을 함께 요구한다.

1. promotion 후보가 필요한 committed prefix를 보유한다.
2. 한 epoch에서 write 권한을 가진 primary가 하나임을 보장한다.
3. client·proxy가 stale topology를 무한히 사용하지 않는다.
4. old primary가 돌아올 때 자동으로 history를 합친다고 가정하지 않고 재가입 절차를 따른다.

합의 알고리즘의 상세 안전성은 챕터 10에 위임한다. 여기서는 DB commit position, promotion과 fencing이라는 관찰 가능한 계약에 집중한다.

## 상태 추적 사례

주문 T42의 commit log position이 500이라고 하자.

```text
12:00:00.000 P local flush=500, async ACK
12:00:00.020 R receive=500, flush=470, apply=450
12:00:00.030 client read routed to R → order missing
12:00:00.060 R flush=500, apply=480
12:00:00.100 R apply=500 → order visible to new snapshot
```

이 timeline에서 30ms read 실패의 직접 원인은 `R_apply < 500`이다. network receive는 끝났지만 apply되지 않았다. 해결 후보를 평가한다.

| 후보 | 얻는 보장 | 비용 |
|---|---|---|
| 직후 read를 primary로 | 해당 primary의 최신 상태 | primary read 부하, failover routing 처리 |
| token 500 이상 replica 선택 | read-your-writes | position 전파, 대기/fallback 구현 |
| remote apply 동기 commit | 즉시 replica visibility | commit latency·가용성 저하 |
| 100ms sleep | 이 표에서는 우연히 성공 | lag 변동 시 보장 없음 |

진단 기록에는 transaction ID, commit position, 선택된 endpoint, receive/flush/apply position과 topology epoch를 같은 request trace에 남긴다.

## 실무 관점

### replica 수를 늘리면 읽기가 선형 확장된다는 오해

모든 read가 replica에서 허용되는 것은 아니며 hot key, apply CPU와 storage bandwidth가 병목일 수 있다. replica마다 cache가 나뉘고 fan-out query가 오히려 network를 늘릴 수 있다. read routing, freshness와 실제 per-replica QPS를 함께 본다.

### lagging replica를 무조건 재시작하지 않는다

network backlog인지 apply wait인지 먼저 구분한다. 재시작은 warm cache와 현재 catch-up 진척을 잃고 bootstrap traffic을 추가할 수 있다. 필요한 log retention이 남아 있는지도 확인한다.

### failover 시간과 데이터 손실 한계는 다른 지표다

빠르게 promote해도 최신 committed prefix가 없으면 data loss가 생길 수 있고, 모든 log를 가진 replica가 있어도 fencing·DNS·connection 재설정 때문에 복구가 느릴 수 있다. RTO 성격의 시간과 RPO 성격의 손실 경계를 분리한다.

## 정리

- 복제는 일관된 snapshot과 이후 log stream을 연결해 replica state를 전진시킨다.
- 물리 복제는 엔진 상태 충실도, 논리 복제는 선택·변환 유연성을 얻지만 각기 호환성과 apply 비용을 낸다.
- receive·flush·apply position은 다른 상태이며 lag을 network·storage·replay 구간으로 나눠야 한다.
- 동기 acknowledgment의 의미는 replica가 어느 단계까지 도달해야 하는지로 정의한다.
- read-your-writes와 monotonic read는 replica 수가 아니라 position-aware routing 또는 대기 계약이 필요하다.
- failover는 최신 replica 선택과 old primary fencing을 함께 만족해야 split-brain을 막는다.

## 확인 문제

1. replica의 receive position은 primary와 같지만 apply position이 계속 뒤처진다. network 증설보다 먼저 볼 증거는 무엇인가?
2. synchronous replication을 켰는데 commit 직후 replica query가 새 행을 못 본다. 가능한 계약 차이를 설명하라.
3. 새 replica bootstrap 중 primary disk의 WAL 사용량이 급증했다. 두 상태가 연결되는 이유는 무엇인가?
4. failover 뒤 old primary가 일부 client의 write를 계속 받았다. 단순 routing 오류보다 더 근본적인 누락 계약은 무엇인가?

<details>
<summary>정답과 해설</summary>

1. replica flush/apply gap, apply worker CPU·I/O, long transaction, lock conflict, parallel worker low-water mark와 replay rate를 본다. 이미 receive했으므로 전송 대역폭이 직접 병목이라는 증거는 약하다.
2. 동기 ACK가 remote receive나 durable flush까지만 기다리고 apply/visibility를 기다리지 않을 수 있다. query snapshot 생성 시점도 확인한다. 제품 설정에서 동기의 정확한 단계가 무엇인지 읽어야 한다.
3. snapshot copy·catch-up 동안 필요한 시작 position 이후 WAL을 삭제할 수 없다. slot/retention이 느린 replica를 보호하면서 primary log 공간을 소비한다.
4. promotion 전에 old primary의 write 권한을 박탈하는 fencing이 빠졌다. topology 갱신만으로 stale client나 partition된 primary의 실행을 막을 수 없다.

</details>

## 참고 자료

- [PostgreSQL: Log-Shipping Standby Servers](https://www.postgresql.org/docs/current/warm-standby.html): base backup, WAL streaming, synchronous replication과 standby 동작을 설명한다.
- [PostgreSQL: Replication Progress Tracking](https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-REPLICATION-VIEW): sent·write·flush·replay 위치를 구분해 관찰하는 공식 지표다.
- [PostgreSQL: Logical Decoding Concepts](https://www.postgresql.org/docs/current/logicaldecoding-explanation.html): WAL을 논리 change stream으로 해석할 때 snapshot과 replication slot이 맡는 역할을 설명한다.
- [MySQL 8.4: Replication Formats](https://dev.mysql.com/doc/refman/8.4/en/replication-formats.html): statement·row·mixed binary logging의 단위와 경계를 비교한다.
- [MySQL 8.4: Semisynchronous Replication](https://dev.mysql.com/doc/refman/8.4/en/replication-semisync.html): source acknowledgment와 replica receipt 사이의 내구성·지연 tradeoff를 보여 주는 제품 사례다.
