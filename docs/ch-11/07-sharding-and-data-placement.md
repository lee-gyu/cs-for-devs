# 11.7 sharding과 데이터 배치 — 데이터를 나누면 질의와 장애도 나뉜다

sharding은 큰 테이블을 여러 서버에 복사하는 기능이 아니라 각 key의 소유 위치와 질의 경로를 바꾸는 배치 결정이다. 균등한 row 수만으로는 좋은 shard key를 고를 수 없다. 저장 bytes·QPS·시간 편향, 관련 데이터의 co-location과 주요 질의의 fan-out을 함께 판단해야 한다.

## 학습 목표

- 단일 노드 partitioning과 여러 실패 영역에 데이터를 배치하는 sharding을 구분한다.
- range·hash·directory routing의 범위 질의·부하 분산·배치 변경 비용을 비교한다.
- shard key를 bytes·QPS·시간 변화·co-location·fan-out으로 평가한다.
- local/global secondary index와 전역 unique·sequence가 요구하는 조정 비용을 설명한다.
- resharding의 copy·catch-up·routing 전환에서 누락·중복 방지 불변식을 추적한다.

## 배경: 고객 수는 균등한데 왜 한 shard만 느린가

주문을 `customer_id % 16`으로 나누면 고객 수와 row 수는 대체로 균등해 보일 수 있다. 판매 이벤트가 시작되자 특정 기업 고객 하나가 전체 주문 QPS의 30%를 만들고, 그 고객의 모든 주문은 한 shard로 향했다. 다른 shard의 CPU와 storage가 남아 있어도 hot shard의 한 key 범위는 더 많은 노드를 추가한다고 자동 분산되지 않는다.

반대로 주문을 무작위 `order_id` hash로 나누면 write는 퍼질 수 있지만 다음 질의는 16개 shard 모두에 요청해야 한다.

```sql
SELECT * FROM orders
WHERE customer_id = :customer_id
ORDER BY created_at DESC
LIMIT 20;
```

각 shard가 local top 20을 반환하고 coordinator가 다시 merge해야 한다. shard key는 저장 분산만 정하지 않는다. 어떤 query가 local operation이 되고 어떤 transaction이 분산되는지를 정한다.

## partitioning과 sharding

partitioning은 하나의 logical table을 key range·hash·list 등으로 나누는 일반 개념이다. 한 DB instance 안의 table partition도 될 수 있다. sharding은 partition을 여러 server·node·failure domain에 배치하고 routing·membership·rebalancing을 함께 관리하는 분산 형태다.

| 구분 | 단일 노드 partition | sharding |
|---|---|---|
| 주된 목적 | pruning·maintenance·locality | capacity·throughput·failure 분산 |
| routing | 한 optimizer/engine 내부 | client/router/catalog와 network |
| transaction | 같은 engine coordinator | cross-shard protocol 가능 |
| 장애 | 주로 한 instance 경계 | partial failure·stale routing 추가 |
| 이동 | local file/page 작업 | network copy·dual state·ownership 전환 |

partition table을 만들었다고 node failure를 견디거나 write capacity가 늘지는 않는다. 반대로 분산 DB가 내부 range를 자동 분할해도 application key가 한 row에 집중되면 그 row보다 작게 split할 수 없다.

## routing 전략

### range sharding

정렬 key의 연속 구간을 shard에 배치한다.

```text
[-∞, 1000)  → shard A
[1000, 2000) → shard B
[2000, +∞)  → shard C
```

range query와 인접 key locality가 좋고 shard pruning이 명확하다. 그러나 단조 증가 timestamp·sequence의 새 write가 마지막 range 한 곳에 집중되는 moving hotspot을 만들 수 있다. range 크기나 load에 따라 split해도 write frontier가 새 마지막 range로 이동하면 hotspot이 따라간다.

### hash sharding

`h(key) mod N` 또는 consistent/rendezvous hash로 key space를 분산한다. skew가 심하지 않다면 write와 storage를 퍼뜨리고 exact key routing이 쉽다. 대신 원래 key 순서가 흩어져 range query와 ordered scan이 여러 shard를 건드린다.

단순 modulo는 N이 바뀔 때 많은 key의 owner가 바뀐다. consistent hashing, virtual node·bucket indirection은 이동 범위를 줄이지만 membership metadata와 load-aware placement가 필요하다. hash가 hot key 하나의 QPS를 여러 shard로 쪼개 주지는 못한다. 같은 key는 여전히 한 owner로 간다.

### directory sharding

별도 directory가 key/range/tenant의 현재 owner를 저장한다.

```text
tenant_17 → shard C
tenant_42 → shard A
tenant_99 → shard D
```

큰 tenant만 독립 shard로 옮기거나 규제 지역·hardware tier에 배치하는 유연성이 있다. 대가로 directory가 routing 경로와 가용성의 핵심 metadata가 된다. cache된 route의 version, directory 장애, atomic ownership 변경과 bootstrap을 다뤄야 한다.

| 전략 | 강점 | 주요 경계 |
|---|---|---|
| range | range scan, locality, pruning | sequential hotspot, uneven ranges |
| hash | 균등 분산, exact lookup | range fan-out, membership 변경 |
| directory | 임의 배치, 큰 tenant 격리 | metadata 가용성·stale route |

실제 시스템은 range directory와 range 내부 hash prefix를 섞을 수 있다.

## shard key 판단 축

### cardinality는 필요조건일 뿐이다

distinct key가 많아야 parallelism 후보가 생기지만 다음 축을 더 본다.

- **bytes**: key별 row 수와 row width가 균등한가?
- **QPS**: read/write 빈도가 균등한가, hot key가 있는가?
- **시간 편향**: 새 key나 최근 range로 부하가 이동하는가?
- **co-location**: 함께 읽고 쓰는 row가 같은 shard에 놓이는가?
- **fan-out**: 주요 query가 shard key를 알고 pruning할 수 있는가?
- **성장·이동**: key를 더 쪼개거나 다른 shard로 옮길 수 있는가?

평균만 보면 판매 이벤트·월말 batch와 큰 tenant를 놓친다. key별 p95/p99 bytes·QPS와 시간대별 분포를 본다.

### co-location과 aggregate 경계

주문을 고객 기준으로 shard하고 `orders`, `order_items`의 key prefix에 `customer_id`를 포함하면 고객별 주문 상세와 transaction이 local이 될 수 있다.

```text
shard key = customer_id

customer 42
 ├─ orders(42, order_7)
 │   └─ order_items(42, order_7, ...)
 └─ orders(42, order_8)
```

하지만 재고가 상품별 전역 상태라면 여러 고객 주문이 같은 inventory row를 갱신한다. inventory를 고객과 함께 복제하면 authoritative 수량을 조정하기 어렵고, 상품 기준으로 두면 주문과 재고가 cross-shard transaction이 된다. 모든 관계를 동시에 co-locate할 shard key는 대개 없다. 가장 중요한 transaction·query를 local로 만들고 남는 cross-shard 경로의 비용을 명시한다.

## scatter-gather와 fan-out

router가 shard key를 알 수 없으면 여러 shard에 query를 보내고 결과를 합친다.

```text
client → coordinator
          ├─ shard A local top-20 ─┐
          ├─ shard B local top-20 ─┼─ merge/sort → global top-20
          └─ shard C local top-20 ─┘
```

fan-out latency는 단순 평균이 아니라 느린 shard와 coordinator queue에 민감하다. shard 수가 늘면 적어도 하나의 tail을 만날 확률도 커진다. aggregate는 partial result를 줄일 수 있지만 exact distinct, global order와 join은 많은 data 이동을 요구할 수 있다.

관찰 항목은 query당 contacted shard 수, cross-shard bytes, local rows 대비 returned rows, coordinator CPU·memory와 slowest shard latency다. 전체 latency만 보고 모든 shard를 동시에 튜닝하지 않는다.

## secondary index의 배치

### local secondary index

각 shard가 자신이 소유한 row만 index한다. write는 owner shard 안에서 transactionally 유지하기 쉽다. query가 shard key를 모르면 모든 local index를 fan-out해야 한다.

```text
shard A: index(status → local order ids)
shard B: index(status → local order ids)
```

### global secondary index

index key 기준으로 별도 shard에 전체 row locator를 배치한다.

```text
global index shard by status/customer
  key → base table shard + primary key
```

query routing을 줄일 수 있지만 base row와 index entry가 다른 shard에 있어 write 원자성·순서와 복구가 어려워진다. 동기 distributed transaction으로 함께 갱신하면 latency·가용성 비용을 내고, 비동기로 유지하면 stale/missing index entry를 허용하고 repair가 필요하다. covering data를 복제하면 base lookup은 줄지만 공간과 update propagation이 늘어난다.

“global index 지원”이라는 기능명보다 다음을 확인한다.

- base write ACK 시 index entry도 durable/visible한가?
- old value 삭제와 new value 추가가 atomic한가?
- stale entry가 가리키는 row가 없을 때 query가 recheck하는가?
- rebuild·resharding 중 query completeness를 어떻게 지키는가?

## 전역 unique와 sequence

한 shard의 unique index는 그 shard 안의 중복만 막는다. email이 shard key가 아닌데 cluster 전체 unique를 보장하려면 다음 중 하나가 필요하다.

- unique value 자체로 owner shard를 정해 한 곳에서 serialize한다.
- global unique index를 distributed transaction으로 유지한다.
- 중앙 allocator/range lease로 key space를 분할한다.
- 충돌 가능성을 충분히 낮춘 분산 ID를 쓰되 이것은 업무상 unique 검증과 다를 수 있다.

단일 sequence row는 모든 ID 발급을 한 hot key에 모을 수 있다. range를 미리 lease하면 coordination을 줄이지만 gap 없는 순서를 포기하고 lease holder failure 때 사용하지 않은 범위가 생길 수 있다. “유일함”, “단조 증가”, “gap 없음”, “commit 순서와 같음”은 서로 다른 계약이다.

## resharding의 상태 전이

range R을 source S에서 destination D로 옮긴다고 하자. 즉시 route만 바꾸면 D에 과거 데이터가 없고, copy부터 한 뒤 route를 바꾸면 copy 중 발생한 write가 빠질 수 있다.

```text
1. snapshot/backfill: S@position p를 D로 copy
2. catch-up: p 이후 change를 D에 적용
3. cutover barrier: ownership epoch 전환
4. verify: row/checksum/position과 read-write 경로 확인
5. cleanup: old route·source data를 안전 시점 뒤 제거
```

이중 상태에서 지킬 핵심 불변식은 다음과 같다.

- 각 accepted write는 최종 owner state에 정확히 한 논리 효과로 존재한다.
- cutover 전 read와 후 read가 허용한 consistency보다 뒤로 가지 않는다.
- 한 ownership epoch에서 authoritative writer는 하나다.
- retry·duplicate change는 transaction/change ID로 멱등 처리한다.
- source 삭제는 stale router와 rollback window가 끝난 뒤 한다.

### dual write의 위험

application이 S와 D에 독립적으로 write하고 둘 다 성공해야 완료하는 방식은 첫 성공 뒤 두 번째 timeout에서 상태를 모호하게 만든다. DBMS migration protocol은 ordered change log, idempotent apply와 ownership epoch로 이 간극을 다뤄야 한다. timeout만으로 첫 write가 실패했다고 가정하지 않는다.

### stale routing

client가 old route로 보내면 source는 새 owner 정보를 반환하거나 proxy해야 한다. 무한 redirect loop를 막기 위해 route version/epoch를 비교하고 metadata cache를 갱신한다. source가 계속 write를 받아 forwarding만 한다면 forwarding lag와 장애 경로가 새 의존성이 된다.

## 배치 진단 사례

판매 이벤트 중 shard 7의 p99만 증가했다.

| 관찰 | 값 | 해석 후보 |
|---|---:|---|
| row count | 전체의 8% | 저장량은 심하게 skew하지 않음 |
| write QPS | 전체의 42% | traffic hot shard |
| top key QPS | shard 7의 70% | 한 고객/상품 hot key |
| CPU | 85% | write·index·coordination 경쟁 |
| bytes | 전체의 9% | 단순 용량 이동만으로 해결 약함 |
| fan-out | 변화 없음 | 이번 incident의 직접 원인은 아닐 가능성 |

shard 7을 둘로 range split해도 hot key 하나가 쪼개지지 않으면 그대로 한 child range에 남는다. key를 sub-shard하고 read에서 합치거나, hot counter를 분산한 뒤 정확한 집계를 조정하는 설계가 필요할 수 있다. 이는 read·transaction 복잡성을 새로 낸다.

## 실무 관점

### 노드를 늘리기 전에 부하 단위를 본다

hot row나 unsplittable range는 idle node가 많아도 한 owner의 직렬화 한계를 넘지 못한다. shard별 평균 대신 key/range별 QPS·CPU·lock wait를 본다.

### hash prefix는 ordering 비용을 이동시킨다

timestamp 앞에 hash bucket을 붙이면 write tail을 여러 range로 분산한다. 대신 시간 범위 query는 모든 bucket을 scan·merge해야 한다. bucket 수를 늘릴수록 write parallelism과 read fan-out이 함께 증가한다.

### 완전 자동 resharding도 application 계약을 없애지 않는다

DB가 range를 자동 이동해도 transaction이 많은 range를 건드리는지, stale read가 허용되는지와 global index consistency는 schema·query가 결정한다. 자동화는 상태 전이를 구현하지만 좋은 shard key를 대신 선택하지 않는다.

## 정리

- sharding은 partition을 여러 failure domain에 배치하고 routing·이동·partial failure를 관리한다.
- range는 locality, hash는 분산, directory는 임의 배치 유연성을 얻지만 각각 hotspot·fan-out·metadata 비용을 낸다.
- shard key는 cardinality가 아니라 bytes·QPS·시간 편향·co-location·fan-out과 재분할 가능성으로 판단한다.
- local index는 write locality, global index는 query routing을 얻으며 global index는 cross-shard consistency 비용을 만든다.
- 전역 unique·sequence는 local constraint보다 coordination이나 key-space allocation을 더 요구한다.
- resharding은 snapshot·catch-up·cutover·verify·cleanup 상태 전이이며 ownership epoch와 멱등 apply가 누락·중복을 막는다.

## 확인 문제

1. timestamp range sharding에서 node를 두 배로 늘려도 최신 주문 write p99가 줄지 않았다. 왜 가능한가?
2. `customer_id` hash shard는 균등하지만 상품별 재고 차감이 cross-shard가 됐다. 어떤 co-location tradeoff가 드러난 것인가?
3. global secondary index를 비동기로 유지한다. query correctness와 repair에서 반드시 다룰 상태는 무엇인가?
4. resharding copy가 끝난 직후 source를 삭제하면 안 되는 이유를 설명하라.

<details>
<summary>정답과 해설</summary>

1. 단조 증가 write가 마지막 range 하나로 이동하는 moving hotspot이다. 새 node가 있어도 current tail owner 하나가 모든 write를 받는다. hash prefix 등으로 write를 퍼뜨리면 range query fan-out 비용이 생긴다.
2. 고객·주문은 local이지만 상품 inventory는 여러 고객이 공유한다. inventory를 상품 기준으로 두면 주문과 cross-shard가 되고 고객마다 복제하면 전역 수량 조정이 어려워진다. 어떤 불변식을 local로 만들지 선택해야 한다.
3. base row만 있거나 index entry만 있는 중간 상태, old/new index entry의 순서, stale locator recheck, retry duplicate와 lag/rebuild 중 누락을 다룬다. base table을 source of truth로 검증·repair하는 절차가 필요하다.
4. snapshot 이후 write catch-up과 ownership cutover가 끝나지 않았을 수 있고 stale router가 source로 요청할 수 있다. position 검증, epoch 전환과 rollback/route cache 안전 기간 뒤 cleanup해야 한다.

</details>

## 참고 자료

- [Google Cloud Spanner: Schema Design Best Practices](https://cloud.google.com/spanner/docs/schema-design): 단조 key hotspot, hash prefix와 관련 row 배치가 분산 비용을 바꾸는 제품 사례다.
- [Google Cloud Spanner: Schema and Data Model](https://cloud.google.com/spanner/docs/schema-and-data-model): contiguous key range split, load-based 분할과 co-location을 설명한다.
- [CockroachDB: Distribution Layer](https://www.cockroachlabs.com/docs/stable/architecture/distribution-layer): range split·merge와 metadata routing이 query·rebalancing 비용에 미치는 영향을 보여 준다.
- [CockroachDB: Understand Hotspots](https://www.cockroachlabs.com/docs/stable/understand-hotspots): hot row·range·moving hotspot을 storage와 QPS 관점에서 구분하는 진단 자료다.
- [Amazon Dynamo Paper](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf): consistent hashing, virtual node와 replica preference list를 이용한 key-value partitioning의 고전 설계를 설명한다.
