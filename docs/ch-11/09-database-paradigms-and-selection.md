# 11.9 데이터베이스 패러다임과 선택 — 데이터 관계와 질의에 맞는 비용을 고른다

데이터베이스 선택은 제품 기능표에서 체크가 가장 많은 항목을 고르는 일이 아니다. 저장 구조는 어떤 관계와 접근을 싸게 만들고 다른 경로의 비용을 애플리케이션·운영으로 이동한다. relational·key-value·wide-column·document·graph·search 계열을 데이터 관계, 주 질의, 필요한 보장과 확장·운영 비용이라는 같은 축에서 비교해야 한다.

## 학습 목표

- 데이터 관계와 주 접근 패턴으로 필요한 저장·인덱스 구조를 도출한다.
- relational·key-value·wide-column·document·graph·search 계열의 대표 내부 메커니즘과 경계를 설명한다.
- schema·constraint·transaction·읽기 일관성과 확장 요구를 제품 기능과 분리해 명시한다.
- 주 저장소와 파생 index/cache를 source of truth·동기화 비용으로 구분한다.
- 후보 두 개의 적합성뿐 아니라 포기하는 query·consistency·운영 능력을 비교한다.

## 배경: “NoSQL이 더 확장된다”는 선택 기준이 아닌 이유

주문, 상품 catalog, session, 추천 graph와 상품 검색은 모두 key-value JSON으로 표현할 수 있다. 표현 가능하다는 사실은 효율적이고 안전한 저장이라는 뜻이 아니다.

- 주문·재고는 여러 row의 constraint와 transaction이 핵심이다.
- 상품 catalog는 한 aggregate를 함께 읽고 필드가 자주 진화할 수 있다.
- session은 정확한 key lookup과 TTL이 지배한다.
- 추천은 가변 길이 관계 traversal이 핵심이다.
- 상품 검색은 token·부분 일치·관련성 ranking과 facet이 필요하다.

한 엔진에 모두 넣을 수 있어도 어떤 질의는 full scan, application join, 수동 constraint 또는 비동기 index를 요구한다. 반대로 각 기능마다 새 저장소를 도입하면 backup·보안·schema migration·관찰·장애 복구와 데이터 동기화가 배수로 늘어난다.

선택의 첫 질문은 “SQL인가 NoSQL인가”가 아니라 다음 네 가지다.

```text
data relationship
  → dominant access pattern
  → correctness/consistency contract
  → scale and operational budget
```

## 공통 비교 축

### 데이터 관계

- 독립된 key-value인가?
- 함께 수명 주기를 갖는 aggregate document인가?
- table 사이의 다양하고 변경 가능한 relation인가?
- partition 안에서 정렬된 sparse row인가?
- edge 자체와 multi-hop path가 핵심인가?
- tokenized text와 relevance가 핵심인가?

### 접근 패턴

`get(key)`, partition range scan, ad-hoc filter·join, aggregate document read/write, graph traversal, full-text search 중 무엇이 QPS와 latency budget을 지배하는지 적는다. 가능성 있는 모든 query를 같은 우선순위로 두면 어떤 구조도 최적화할 수 없다.

### 계약

| 계약 | 확인 질문 |
|---|---|
| schema | type·required field·migration을 누가 검증하는가? |
| constraint | unique·reference·업무 불변식을 어디서 원자적으로 지키는가? |
| transaction | 한 원자 단위가 key·document·partition·여러 row 중 어디까지인가? |
| read consistency | read-your-writes·snapshot·linearizable read가 어느 경로에 필요한가? |
| durability | ACK 뒤 어떤 failure까지 보존하며 persistence 설정은 무엇인가? |

### 규모와 운영

working set, read/write 비율, row/document 크기, 성장률과 geography를 적는다. 수평 확장 여부만이 아니라 shard key, fan-out, rebalancing·compaction, backup/restore, upgrade와 전문 인력 비용을 포함한다.

## 패러다임 비교표

표는 제품 보장이 아니라 각 계열에서 흔한 구조적 경향이다. 같은 계열의 제품도 transaction·query·consistency가 다르다.

| 계열 | 대표 구조 | 잘 맞는 접근 | 주요 비용·경계 |
|---|---|---|---|
| Key-value | key directory/hash, memory 중심 구조, TTL·eviction 선택 | exact key get/set, counter, session·cache | key를 모르는 query, 관계 탐색, RAM·eviction, persistence별 내구성 |
| Wide-column | partition key + clustering order, 분산 LSM | partition lookup·range, 대량 write, sparse/time-series | query-first schema, hot/wide partition, cross-partition query·transaction |
| Document | aggregate document, field/path index | 한 aggregate read/write, 유연한 중첩 구조 | document growth, 중복, cross-document join·constraint·migration |
| Relational | typed table, constraint, B+tree, optimizer·join, ACID | 관계·ad-hoc query, 다중 row transaction | join·contention, schema migration, sharding·cross-shard coordination |
| Graph | node·edge·property, adjacency traversal | 가변 깊이 path·pattern, relationship 중심 질의 | supernode, global aggregate, graph partitioning·cross-partition traversal |
| Search | analyzer·token, inverted index, segment merge | full-text, relevance, prefix/fuzzy, facet | refresh lag, reindex·segment merge, source-of-truth transaction 부적합 |

## key-value: key를 알고 있을 때의 단순성을 산다

key-value store는 key를 통해 value나 native data structure에 직접 접근한다. hash table, sorted structure와 memory 중심 실행으로 낮은 지연을 만들 수 있다. 그러나 “key-value는 sub-millisecond”는 모델의 보장이 아니다. network hop, persistence fsync, replication, value size, eviction와 hot key가 실제 지연을 결정한다.

Redis는 string 외에도 hash·set·sorted set·stream 등 server-side data type을 제공한다. Memcached는 단순 cache에 더 집중한다. 같은 계열이라는 이유로 transaction·persistence·replication 계약이 같지 않다.

### 적합한 조건

- caller가 key를 정확히 안다.
- operation이 get/set/increment·TTL처럼 제한적이다.
- value 사이 ad-hoc relation을 DB가 찾을 필요가 없다.
- cache라면 eviction 후 원본에서 재구성할 수 있다.

### 경계

cache와 source of truth를 구분한다. max memory에서 key가 eviction될 수 있는 설정은 session·rate limit 정확성에 영향을 준다. Redis의 RDB snapshot, AOF와 persistence 없음은 서로 다른 data loss·latency 계약이다. “Redis를 쓴다”만으로 내구성을 설명할 수 없다.

secondary lookup을 위해 `email → user_id`, `user_id → profile` 두 key를 application이 함께 유지하면 원자적 갱신과 stale entry repair 책임이 생긴다. 제한된 query가 늘면 관계형·document index가 더 단순할 수 있다.

## wide-column: partition 안의 정렬된 질의를 산다

wide-column store는 partition key로 data placement를 정하고 partition 내부를 clustering key 순서로 저장하는 모델이 흔하다. Cassandra 계열의 LSM storage는 commit log·memtable·SSTable과 compaction으로 write를 흡수한다.

```text
partition key = device_id
clustering key = event_time

device_42 → [10:00 event] [10:01 event] [10:02 event] ...
```

### 적합한 조건

- query가 partition key를 포함한다.
- 한 partition의 시간·순서 range scan이 지배한다.
- 대량 append/write와 multi-node capacity가 중요하다.
- query 패턴을 미리 알고 그에 맞춘 table을 중복 설계할 수 있다.

### 경계

모든 event를 날짜 하나 partition에 넣으면 hot·wide partition이 된다. tenant별 QPS·partition bytes와 tombstone scan을 관찰한다. cross-partition filter·join은 fan-out과 application merge를 만들 수 있다.

Cassandra와 HBase는 같은 wide-column 계열로 묶여도 leader/consistency, transaction과 storage API가 다르다. Cassandra의 lightweight transaction이나 batch 기능을 모든 row의 범용 serializable transaction으로 일반화하지 않는다. 공식 문서에서 partition 범위와 consistency level을 확인한다.

## document: aggregate 경계를 저장 단위로 삼는다

document store는 JSON 유사 document에 중첩 object·array를 함께 저장하고 field/path index를 제공한다. 상품의 옵션·속성처럼 함께 읽고 수정되는 aggregate를 한 document로 두면 join 없이 가져올 수 있다.

```json
{
  "productId": "p-42",
  "name": "keyboard",
  "variants": [
    { "color": "black", "stockKeepingUnit": "k-b" }
  ]
}
```

### `schema-less`라는 오해

data에 schema가 없는 것이 아니다. 어떤 field가 존재하고 타입·의미가 무엇인지 application은 여전히 가정한다. DB-level validation이 선택적이면 책임이 application, validator와 migration job으로 이동한다. MongoDB도 schema validation을 제공하며 Firestore의 transaction·query 제약은 MongoDB와 동일하지 않다.

### embed와 reference

함께 읽고 같은 수명 주기를 가진 bounded child는 embed가 유리하다. 여러 aggregate가 공유하거나 독립적으로 커지는 entity는 reference가 중복·document growth를 줄인다. reference는 application join 또는 DB lookup을 만들고 cross-document consistency가 필요할 수 있다.

document transaction 지원이 생겼다고 모든 관계형 workload가 같은 비용이 되는 것은 아니다. multi-document transaction은 shard coordination과 lock/version 유지 비용을 내며 foreign key·ad-hoc join·constraint 표현력은 제품별로 다르다.

## relational: 관계와 제약, 질의 유연성을 산다

관계형 DBMS는 typed table과 key로 relation을 표현하고 optimizer가 access path와 join order를 선택한다. unique·foreign key·check 같은 constraint와 여러 row transaction은 주문·재고·원장처럼 불변식이 핵심인 system of record에 강한 기본값이다.

### 적합한 조건

- relation과 query가 기능 발전에 따라 바뀐다.
- ad-hoc filter·join·aggregate가 중요하다.
- 여러 row/table의 원자성과 referential integrity가 필요하다.
- schema·constraint를 중앙에서 검증할 가치가 크다.

### 경계

정규화된 join은 중간 행·random lookup과 optimizer 오판 비용을 낼 수 있다. hot row의 write serialization, index maintenance와 long transaction이 throughput을 제한한다. 단일 node를 넘으면 shard key와 distributed transaction이라는 07·08 파트의 비용이 생긴다.

“관계형은 확장되지 않는다”도 과도한 일반화다. read replica, partitioning·sharding과 distributed SQL이 있지만 강한 constraint·transaction을 여러 node에 유지할수록 network·consensus 비용을 지불한다. 기능 가능성과 workload 적합성을 분리한다.

## graph: 관계를 일급 저장 경로로 삼는다

property graph는 node, directed relationship와 양쪽 property로 data를 표현한다. 시작 node를 index로 찾은 뒤 adjacency를 따라가면 가변 길이 path와 neighborhood 탐색을 자연스럽게 수행한다.

```text
(customer)-[:PLACED]->(order)-[:CONTAINS]->(product)
       └─[:SHARES_DEVICE_WITH]─>(customer)
```

### 적합한 조건

- “A와 B가 어떻게 연결되는가”가 핵심 질문이다.
- traversal 깊이와 pattern이 query마다 달라진다.
- 추천·fraud·권한·dependency처럼 edge 자체가 domain data다.

### 경계

degree가 매우 큰 supernode는 한 traversal에서 방대한 edge를 펼친다. 전체 graph aggregate와 단순 key lookup이 자동으로 관계형·KV보다 싸지는 않는다. graph를 shard하면 path가 partition boundary를 반복해 network traversal이 될 수 있다.

관계형에서도 recursive query와 join table로 graph를 표현할 수 있고 graph DB도 시작 node를 위한 index와 constraint가 필요하다. 고정 깊이 join 몇 개 때문에 graph를 도입하지 말고 실제 multi-hop latency, update와 운영 비용을 비교한다.

## search engine: text를 token에서 document로 역참조한다

검색 엔진은 analyzer가 text를 token으로 바꾸고 inverted index가 `term → postings(document IDs, positions, frequency...)`를 저장한다.

```text
"red keyboard" → [red, keyboard]

red      → doc 1, doc 8, doc 20
keyboard → doc 1, doc 2, doc 20
```

이를 이용해 full-text, phrase·prefix/fuzzy match, relevance ranking과 facet을 수행한다. row store의 B+tree가 문자열 포함·형태소·점수를 같은 방식으로 처리하지는 않는다.

### refresh와 merge

write는 새 immutable segment가 refresh되며 검색 가능해지고 background merge가 segment를 합치는 구조가 흔하다. ACK한 document가 즉시 모든 search에 보이지 않는 near-real-time 경계, merge I/O와 deleted document 공간이 생긴다. mapping/analyzer를 바꾸면 기존 token을 다시 만들기 위해 reindex가 필요할 수 있다.

Elasticsearch query는 여러 shard에서 local result를 모아 coordinator가 global top-k를 만들 수 있어 shard 수와 ranking fan-out이 tail latency에 영향을 준다.

### source of truth 경계

검색 index는 주문 상태의 unique·foreign key와 다중 row transaction을 위한 기본 저장소로 삼기 어렵다. 일반적으로 authoritative DB의 change를 비동기로 index한다. 그러면 누락·중복·순서 역전, reindex와 freshness SLO를 운영해야 한다. 검색 결과에서 결제·권한 같은 결정을 바로 확정하기 전에 source of truth를 재검증한다.

## workload 선택 절차

### 1. 핵심 operation을 빈도와 예산으로 적는다

```text
O1: order by id, 5k QPS, p99 < 20ms, read-your-writes
O2: create order + decrement inventory, 1k QPS, atomic
O3: product text search, 2k QPS, freshness < 3s
O4: fraud graph 3~5 hops, 50 QPS, p95 < 500ms
```

“빠른 검색”처럼 측정 불가능한 표현을 피한다.

### 2. 불변식과 source of truth를 정한다

주문·재고 원자성, email unique와 허용 staleness를 적는다. 어느 저장소가 authoritative한지 하나씩 정한다. 두 source of truth를 동기화로 맞추겠다는 설계는 conflict resolution이 없으면 모순이다.

### 3. 후보가 local하게 처리하는 것과 fan-out을 표시한다

각 operation에서 key/partition을 알 수 있는지, join·traversal·search가 몇 node와 index를 건드리는지 예상한다. storage bytes뿐 아니라 cross-shard bytes와 background compaction/reindex를 포함한다.

### 4. 포기 비용을 쓴다

| 후보 | 얻는 것 | 포기·추가 책임 |
|---|---|---|
| relational | constraint·transaction·ad-hoc join | text relevance용 별도 index, hot write·sharding 비용 |
| document | aggregate read·schema 유연성 | cross-aggregate constraint·join, migration discipline |
| wide-column | partition write·scale | query-first duplication, cross-partition 분석 |
| search | relevance·full-text | eventual visibility, source DB 동기화·reindex |

### 5. 대표 분포로 검증한다

평균 document가 아니라 최대 document, 평균 tenant가 아니라 hot tenant, 정상 query뿐 아니라 backfill·restore·node loss를 시험한다. vendor benchmark 대신 실제 key distribution, read/write 비율과 consistency 설정을 사용한다.

## polyglot persistence의 경계

주문은 relational, session은 key-value, 검색은 search index로 나누는 것이 합리적일 수 있다. 하지만 polyglot persistence는 “각 문제에 최고의 DB”가 아니라 다음 비용을 감당할 때 선택한다.

- schema와 client library가 여러 종류다.
- backup·restore와 disaster recovery를 각각 검증한다.
- 권한·암호화·감사와 patch/upgrade 표면이 늘어난다.
- change propagation의 누락·중복·순서·rebuild를 운영한다.
- 장애 때 어느 사본이 authoritative한지 판단해야 한다.

새 저장소는 핵심 access pattern을 기존 시스템에서 합리적으로 제공할 수 없고, 독립된 data ownership 또는 파생 index라는 경계가 명확하며, 운영팀이 그 lifecycle을 감당할 때 도입한다. 단순한 편의나 유행은 이 비용을 정당화하지 못한다.

## 사례: 주문 플랫폼의 저장소 역할

| 데이터·기능 | 기본 후보 | 근거 | 별도 검증 |
|---|---|---|---|
| 주문·재고·결제 원장 | relational | constraint와 다중 row transaction | hot product contention, shard 경계 |
| 로그인 session | key-value | exact key, TTL, 짧은 value | eviction·persistence, hot session |
| 상품 catalog | relational 또는 document | relation/ad-hoc query 대 aggregate evolution | variant 크기, cross-document constraint |
| 상품 검색 | search index | analyzer·inverted index·ranking | source DB 동기화, freshness·reindex |
| 사기 관계 탐색 | graph 또는 relational 대조 | 가변 multi-hop pattern | supernode, update·partition 비용 |
| 대량 device event | wide-column 후보 | partition/time range와 write ingest | partition 크기·tombstone·query 고정성 |

이 표는 제품 결론이 아니다. 예를 들어 catalog가 주문과 강한 foreign key·transaction을 공유하고 query가 관계형으로 충분하면 document store를 추가할 이유가 약하다. graph query가 하루 몇 번의 offline 분석이라면 relational export와 batch graph engine이 운영 DB 추가보다 나을 수 있다.

## 실무 관점

### 기능 지원 여부와 적합성을 혼동하지 않는다

document DB가 join·transaction을, relational DB가 JSON·full-text를 지원할 수 있다. 기능이 존재한다는 사실과 주 workload에서 예측 가능한 비용·운영 성숙도를 제공한다는 사실은 다르다. 실행 계획, shard 범위와 failure contract를 측정한다.

### latency 수치를 패러다임 특성으로 일반화하지 않는다

Redis·Memcached의 낮은 지연은 memory residency, value size, network와 persistence 설정의 결과다. relational point lookup도 cache에서 매우 빠를 수 있고 key-value가 cross-region quorum을 기다리면 느릴 수 있다. 같은 환경·계약·분포로 비교한다.

### “schema 유연성”은 migration 제거가 아니다

old/new document가 공존하면 reader가 여러 version을 이해하거나 background migration을 수행해야 한다. validation을 늦추는 것은 책임의 위치를 바꾼 것이며 data 의미 변화를 없애지 않는다.

## 정리

- DBMS 계열은 표현 가능한 데이터보다 싸게 만드는 관계·접근과 이동시키는 비용으로 비교한다.
- key-value는 exact key, wide-column은 partition range, document는 aggregate, relational은 관계·constraint, graph는 path, search는 text relevance에 중심을 둔다.
- 같은 계열 제품도 transaction·consistency·query·persistence 보장이 다르므로 공식 계약을 확인한다.
- source of truth와 cache·search 같은 파생 상태를 구분하고 동기화의 누락·중복·rebuild 비용을 포함한다.
- polyglot persistence는 독립 ownership과 운영 능력이 추가 lifecycle 비용을 정당화할 때만 선택한다.
- 후보 비교에는 적합성뿐 아니라 포기하는 query·consistency와 새 운영 책임을 기록한다.

## 확인 문제

1. 상품 catalog를 document DB로 옮기려 한다. 후보를 지지하는 조건과 반대하는 조건을 각각 제시하라.
2. Redis에서 p99 1ms라는 benchmark만으로 주문 원장을 옮길 수 없는 이유는 무엇인가?
3. 상품 검색을 Elasticsearch에 비동기 색인한다. source of truth와 freshness·correctness 계약을 어떻게 나눌 것인가?
4. device event workload에 wide-column과 relational 두 후보가 있다. 무엇을 얻고 포기하는지 비교하라.

<details>
<summary>정답과 해설</summary>

1. variant와 속성이 bounded aggregate이고 함께 읽고 쓰며 구조가 자주 진화하면 지지한다. 여러 상품·supplier의 foreign key·transaction, ad-hoc join과 강한 constraint가 지배하면 relational 유지가 단순할 수 있다. document 최대 크기와 migration도 검증한다.
2. benchmark의 memory, network, persistence·replication과 value 분포가 주문 계약과 다르다. 주문 원장은 다중 row 불변식, durable commit, 복구·감사와 ad-hoc query가 필요하다. key-value에서 이를 application secondary key와 workflow로 재구현하는 비용을 포함해야 한다.
3. 주문/상품 DB를 authoritative하게 두고 search는 파생 index로 둔다. 허용 refresh lag, 누락·중복·순서 역전 처리와 full rebuild를 정의한다. 결제·권한 결정은 source DB에서 재검증한다.
4. partition/time range와 대량 write가 고정되어 있으면 wide-column이 분산 ingest를 얻지만 query-first 중복, hot partition과 cross-partition 분석 비용을 낸다. relational은 constraint·ad-hoc query를 얻지만 index write, 단일 hot path와 sharding 시 coordination을 검증해야 한다.

</details>

## 참고 자료

- [Redis: Data Types](https://redis.io/docs/latest/develop/data-types/): key 기반 native structure와 operation 범위를 설명한다.
- [Redis: Persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/): RDB snapshot·AOF·persistence 없음이 만드는 서로 다른 내구성 경계다.
- [Apache Cassandra: Architecture Overview](https://cassandra.apache.org/doc/stable/cassandra/architecture/overview.html): partition key 중심 query와 분산 wide-column 모델을 설명한다.
- [Apache Cassandra: Storage Engine](https://cassandra.apache.org/doc/stable/cassandra/architecture/storage-engine.html): commit log·memtable·SSTable·compaction의 write/read amplification을 확인한다.
- [MongoDB: Data Modeling](https://www.mongodb.com/docs/manual/data-modeling/): embed/reference와 workload 기반 document 경계를 설명한다.
- [MongoDB: Schema Validation](https://www.mongodb.com/docs/manual/core/schema-validation/): document 모델도 validation과 schema 책임을 가진다는 공식 근거다.
- [PostgreSQL: Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html): unique·foreign key·check로 관계형 불변식을 표현하는 범위와 한계를 설명한다.
- [Neo4j: Graph Database Concepts](https://neo4j.com/docs/getting-started/appendix/graphdb-concepts/): property graph의 node·relationship·path traversal 모델을 설명한다.
- [Elasticsearch: Near Real-Time Search](https://www.elastic.co/guide/en/elasticsearch/reference/current/near-real-time.html): refresh 뒤 segment가 검색 가능해지는 visibility 경계를 설명한다.
- [Apache Lucene: Index File Formats](https://lucene.apache.org/core/9_12_0/core/org/apache/lucene/codecs/lucene912/package-summary.html): inverted index의 segment·postings 저장 구조를 확인한다.
