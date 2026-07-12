# 11.2 인덱스와 스토리지 엔진 — 빠른 읽기는 다른 경로의 비용을 남긴다

인덱스는 검색을 공짜로 빠르게 만드는 장식이 아니다. 별도의 정렬·hash 구조를 저장하고 모든 관련 쓰기에서 유지하는 접근 경로다. B+트리·hash·LSM의 적합성은 자료구조 이름이 아니라 point/range/write 비율, 데이터 배치와 read·write·space amplification으로 판단한다.

## 학습 목표

- B+트리의 fan-out·높이·leaf 순회와 page split을 page I/O 비용으로 설명한다.
- hash index와 B+트리의 equality·range·order 지원 경계를 비교한다.
- LSM의 memtable·immutable run·compaction·Bloom filter 상태 전이를 추적한다.
- clustered·unclustered, primary·secondary와 covering 접근을 데이터 배치와 추가 lookup 횟수로 구분한다.
- 복합 인덱스의 열 순서를 읽는 범위·정렬·쓰기·공간 비용으로 평가한다.

## 배경: 인덱스가 없으면 느리고, 많으면 왜 또 느린가

고객별 최근 주문을 다음처럼 조회한다고 하자.

```sql
SELECT order_id, status, created_at
FROM orders
WHERE customer_id = :customer_id
ORDER BY created_at DESC
LIMIT 20;
```

heap 전체를 읽으면 데이터 증가에 따라 검사할 페이지가 늘어난다. `(customer_id, created_at)` 순서의 정렬 인덱스는 고객의 leaf 구간으로 내려간 뒤 최근 항목 20개를 읽을 수 있다. 그러나 이 인덱스는 주문 삽입마다 key와 row locator를 기록하고, leaf 공간이 없으면 분할하며, 캐시와 로그 공간을 소비한다.

`status`, `region`, `product_id`에도 각각 인덱스를 추가하면 조회 후보는 많아지지만 모든 주문 상태 변경이 여러 구조를 수정한다. optimizer가 선택하지 않는 인덱스도 쓰기 비용은 낸다. 따라서 질문은 “이 열에 인덱스를 걸까?”가 아니라 다음처럼 바뀌어야 한다.

- 이 접근 경로는 후보 페이지와 row lookup을 얼마나 줄이는가?
- 필요한 정렬과 projection까지 만족하는가?
- 삽입·갱신·삭제마다 몇 구조와 바이트를 바꾸는가?
- split·compaction의 background 작업이 foreground 지연에 언제 나타나는가?

## B+트리: 정렬된 페이지 계층

### 내부 노드는 범위를, leaf는 항목을 담는다

B+트리(B+ tree)는 높은 fan-out을 가진 균형 검색 트리다. 단순화하면 내부 노드는 separator key와 child page pointer를, leaf는 정렬된 key와 record 또는 row locator를 보관한다. leaf끼리 연결하면 첫 key를 찾은 뒤 인접 leaf를 따라 range scan할 수 있다.

```text
                         [ 300 | 700 ]
                         /     |      \
               [100|200]   [400|600]   [800|900]
                  │             │            │
leaf: [..100..] ⇄ [..200..] ⇄ [..300..] ⇄ [..400..] ⇄ ...
```

한 내부 페이지에 많은 child pointer가 들어가므로 데이터가 커져도 높이는 천천히 증가한다. 하지만 `O(log n)`만으로 실제 비용을 알 수 없다. 상위 페이지가 buffer에 상주하는지, leaf와 data page를 몇 개 읽는지, 한 page에 key가 몇 개 들어가는지가 더 직접적인 I/O 모델이다.

point lookup의 단순 비용은 다음처럼 분해할 수 있다.

```text
root-to-leaf page visits
+ matching leaf pages
+ data page lookups (index가 record 자체를 담지 않을 때)
```

range query는 시작점을 찾는 tree descent보다 leaf와 data page 순회가 지배할 수 있다. 결과가 테이블 대부분이라면 인덱스를 거친 random lookup보다 sequential scan이 더 쌀 수 있다. “인덱스가 있는데 왜 full scan인가”는 optimizer가 틀렸다는 증거가 아니다.

### fan-out과 key 폭

내부 entry가 `key + pointer + metadata`를 차지한다면 key가 넓을수록 페이지당 child 수, 즉 fan-out이 줄어든다. leaf도 같은 page에 더 적은 entry가 들어가 페이지 수와 cache footprint가 커진다. 긴 문자열이나 넓은 복합 key는 비교 CPU뿐 아니라 tree 높이와 page density에 영향을 준다.

큰 primary key가 secondary index entry에 반복되는 엔진에서는 영향이 더 넓다. 예를 들어 InnoDB secondary index는 clustered key를 row locator로 저장하므로 primary key 폭이 모든 secondary index 크기에 전파된다. 이것은 clustered index의 보편 정의가 아니라 InnoDB의 구체적 구현 사례다.

### 삽입과 page split

삽입할 leaf에 공간이 있으면 정렬 위치에 entry를 추가한다. 공간이 없으면 엔진은 보통 page를 나누고 separator를 부모에 반영한다. 부모도 가득 찼다면 분할이 위로 전파될 수 있다.

```text
before: [10 20 30 40] + insert 25
                │ full
                ▼
after:  [10 20] ⇄ [25 30 40]
                  parent에 separator 추가
```

split은 새 page 할당, entry 이동, parent 수정, WAL과 cache 변경을 만든다. 단조 증가 key는 tree의 오른쪽 끝에 삽입이 집중되어 latch contention과 hot page를 만들 수 있고, 무작위 key는 여러 leaf에 쓰기를 흩지만 locality와 page density를 악화시킬 수 있다. 어느 쪽이 항상 낫지는 않다.

fill factor나 여유 공간은 split을 늦추지만 더 큰 tree와 cache footprint를 만든다. split 횟수만 줄이지 말고 page occupancy, written pages, WAL bytes와 foreground latency를 함께 측정한다.

## hash index: equality를 위해 순서를 포기한다

hash index는 key를 hash bucket에 매핑한다.

```text
bucket = h(customer_id) mod bucket_count
```

분포가 적절하고 충돌 관리가 안정적이면 equality lookup은 적은 bucket 접근으로 끝날 수 있다. 그러나 hash는 key의 전체 순서를 보존하지 않으므로 일반적인 range, prefix ordering, `ORDER BY`를 직접 제공하지 못한다. bucket overflow와 resize도 비용을 만든다.

| 질문 | B+트리 | hash |
|---|---|---|
| `key = ?` | 지원, tree descent | 주된 강점 |
| `key BETWEEN ? AND ?` | 시작 leaf 뒤 순회 | 일반적으로 부적합 |
| key 순서 출력 | leaf 순서 활용 가능 | 별도 sort 필요 |
| 동적 성장 | page split·merge | bucket split·resize·overflow |
| skew 영향 | 특정 leaf hot spot | 특정 bucket·hash collision |

제품이 `HASH`라는 이름을 제공해도 persistence, concurrency와 지원 operator는 다를 수 있다. 예를 들어 메모리 내부 adaptive hash와 사용자가 생성하는 영구 hash index는 같은 계약이 아니다.

## LSM: 쓰기를 모아 순차 구조로 바꾼다

로그 구조 병합 트리(log-structured merge-tree, LSM-tree)는 update를 제자리의 정렬 page에 즉시 반영하는 대신 메모리의 정렬 구조에 모은 뒤 immutable sorted run으로 내보내고, background compaction으로 여러 run을 병합한다.

```text
write
  ├─ WAL
  └─ mutable memtable
          │ full
          ▼
     immutable memtable
          │ flush
          ▼
L0: [SSTable A] [SSTable B] [SSTable C]
          │ compaction
          ▼
L1: [----------- sorted non/less-overlapping runs -----------]
          │
L2: [---------------- larger sorted runs --------------------]
```

SSTable(sorted string table)은 대표적 구현 용어이며 모든 LSM이 정확히 같은 level 구조를 쓰는 것은 아니다. size-tiered, leveled, universal compaction은 overlap, write amplification과 space amplification을 다르게 교환한다.

### 쓰기 경로

foreground write는 보통 WAL과 memtable에 append/update하고, 가득 찬 memtable을 immutable로 전환한다. 작은 random update를 큰 sequential run 생성으로 바꾸어 ingest 처리량을 높일 수 있다. 그러나 compaction이 쓰기를 다시 읽고 여러 level에 다시 쓰므로 사용자 데이터 1바이트가 장치에 1바이트만 쓰이는 것은 아니다.

```text
write amplification = storage에 기록한 총 바이트 / 논리적으로 쓴 사용자 바이트
```

정확한 분모와 포함 범위는 제품 지표마다 다르므로 수치를 비교할 때 WAL·replication·compaction 포함 여부를 확인한다.

### 읽기 경로와 Bloom filter

point lookup은 memtable과 최신 run부터 key를 찾으며 같은 key의 여러 version과 tombstone을 만날 수 있다. 여러 run을 확인하면 read amplification이 커진다. Bloom filter는 “이 run에 key가 확실히 없다”를 적은 메모리로 판정해 불필요한 read를 줄인다. false positive는 가능하지만 false negative가 없어야 하는 확률적 필터라는 계약을 이용한다.

Bloom filter는 존재하지 않는 key lookup을 특히 줄이지만 range scan에서 결과 범위를 순서대로 병합해야 하는 비용을 없애지 않는다. filter memory, block index와 cache도 공간을 사용한다.

### compaction debt와 write stall

ingest 속도가 compaction 처리량을 오래 넘으면 immutable run과 overlap이 쌓인다. read amplification과 임시 공간이 증가하고, 한도를 넘으면 foreground write를 throttle하거나 stall해 회복할 시간을 벌 수 있다. 평균 write latency가 낮다가 꼬리 지연이 급격히 커지는 경계다.

진단에서는 단순 write QPS뿐 아니라 다음을 본다.

- level별 file·bytes와 overlap
- pending compaction bytes 또는 compaction debt
- compaction read/write bytes
- flush·compaction stall time
- block cache와 Bloom filter hit/usefulness
- tombstone와 오래된 version 정리 속도

## B+트리와 LSM을 증폭으로 비교한다

| 축 | B+트리 계열의 경향 | LSM 계열의 경향 |
|---|---|---|
| point read | 한 tree path와 필요 시 data lookup | memtable·여러 run 확인, filter/cache로 완화 |
| range read | 정렬 leaf 순회 | 여러 sorted run merge와 version 제거 |
| write | target page의 random update·split | memtable에 모아 flush, 이후 compaction |
| read amplification | tree와 secondary lookup | run·level 수와 overlap 영향 |
| write amplification | page·index·WAL, split | WAL·flush·반복 compaction |
| space amplification | free space·old page·secondary index | 중복 version·tombstone·compaction 임시 공간 |
| latency 경계 | hot leaf·latch, dirty flush, split | flush backlog, compaction debt, write stall |

이 표는 경향이지 제품 benchmark가 아니다. B+트리도 buffered write와 compression을 쓰며, LSM도 block index·cache와 다양한 compaction을 쓴다. 장치와 workload가 주어지기 전에는 구조 이름만으로 승자를 고를 수 없다.

## primary·secondary와 clustered·unclustered

용어를 두 축으로 분리한다.

- primary/secondary는 대개 논리적 key 역할 또는 주된/추가 인덱스를 가리킨다.
- clustered/unclustered는 index 순서와 row data의 물리 배치 관계를 가리킨다.

제품마다 정의가 다르다. InnoDB의 clustered index leaf는 row data를 담고 secondary leaf는 secondary key와 primary key를 담는다. PostgreSQL heap과 일반 B-tree index의 관계는 같은 방식의 clustered storage가 아니며 `CLUSTER` 명령도 지속적인 배치 유지 계약이 다르다.

비용은 이름 대신 lookup 단계로 표현한다.

```text
covering/clustered lookup:
  root → leaf → 필요한 값

unclustered secondary lookup:
  secondary root → leaf → row locator
                          ↓
                       data page
```

두 번째 경로에서 결과 row locator가 여러 data page에 흩어져 있으면 결과 수만큼 random page 접근이 생길 수 있다. 반대로 필요한 data page가 buffer에 있거나 locator가 같은 page에 모이면 실제 I/O는 줄어든다.

## 복합 인덱스와 covering 접근

### 열 순서는 정렬된 탐색 공간을 정한다

`(customer_id, status, created_at)` B+트리는 사전식 순서로 정렬된다.

```text
(customer, status, created_at)
(A, PAID, 10:00)
(A, PAID, 11:00)
(A, READY, 09:00)
(B, PAID, 08:00)
```

leading column의 equality는 탐색 구간을 좁힌다. 첫 range 조건 이후의 열은 filter에는 쓸 수 있어도 연속 scan 범위를 더 줄이지 못할 수 있다. 다만 PostgreSQL의 skip scan처럼 엔진이 반복 탐색으로 이 경계를 완화하는 구현도 있으므로 “왼쪽 열 없이는 절대 못 쓴다”를 보편 규칙으로 단정하지 않는다.

열 순서를 고를 때 선택도 하나만 보지 않는다.

1. 실제 predicate 조합과 빈도를 적는다.
2. equality·range·ordering이 요구하는 연속 구간을 찾는다.
3. 예상 leaf entry와 data page lookup 수를 비교한다.
4. key 폭, update 빈도와 중복 인덱스를 계산한다.
5. 데이터 분포가 변한 뒤에도 계획이 유효한지 관찰한다.

### covering은 heap lookup을 줄이는 대신 인덱스를 넓힌다

질의에 필요한 모든 값을 인덱스 entry에서 얻으면 covering index 또는 index-only 접근 후보가 된다. 그러나 “모든 열을 `INCLUDE`하면 빠르다”는 결론은 틀리다.

- leaf entry가 넓어져 fan-out과 cache density가 낮아진다.
- 포함 열 update도 index maintenance를 만들 수 있다.
- MVCC visibility를 확인하려고 heap 접근이 남는 엔진도 있다.
- 자주 쓰지 않는 projection까지 포함하면 공간과 write amplification만 늘 수 있다.

covering 여부는 실행 계획의 노드 이름뿐 아니라 heap/data page fetch가 실제로 줄었는지 확인한다.

## 관찰 절차: 인덱스 변경을 비용표로 검증한다

주문 워크로드에서 한 번에 한 변수만 바꾼다.

| 단계 | 조건 | 측정 전 예측 |
|---|---|---|
| A | 인덱스 없음 | 고객 조회가 많은 heap page를 읽고 별도 sort 가능 |
| B | `(customer_id, created_at)` | leaf 범위와 정렬을 이용해 읽기 감소, insert 비용 증가 |
| C | projection 포함 covering 후보 | data lookup 감소, index bytes·write 증가 |
| D | 단조/무작위 key 삽입 비교 | hot leaf와 split·locality 패턴 차이 |

최소 관찰 항목은 다음과 같다.

```text
workload: point/range/write 비율, key 분포, row width
read: index pages, data pages, returned rows, sort 여부
write: modified pages, split 또는 compaction, WAL/write bytes
space: table/index bytes, occupancy 또는 level별 bytes
latency: p50/p95/p99와 stall·wait
```

엔진이 split count나 amplification을 직접 제공하지 않으면 만들어 내지 않는다. index size 변화, page inspection, WAL bytes와 write latency 같은 가능한 증거로 범위를 제한하고 `N/A`를 명시한다.

## 실무 관점

### 저선택도 열에는 인덱스가 쓸모없다는 단정

`status` 값이 네 종류뿐이어도 `READY`가 전체의 0.01%이고 그 행만 자주 찾는다면 작은 partial index나 복합 경로가 유용할 수 있다. 반대로 `PAID`가 80%면 인덱스가 많은 row locator와 data page를 읽어 scan보다 비쌀 수 있다. distinct count 하나가 아니라 조건별 빈도와 clustering을 본다.

### 사용되지 않는 인덱스를 즉시 삭제하는 위험

관찰 기간이 월말·장애 복구·희귀 제약 검사를 포함하는지 확인한다. unique constraint를 뒷받침하거나 replica의 다른 workload가 사용할 수도 있다. 삭제 전 optimizer에서 보이지 않게 하는 기능이 있다면 제한적으로 검증하고, 쓰기·공간 이득과 회귀 query를 함께 측정한다.

### 평균 compaction 처리량만 보는 위험

평균적으로 ingest와 같아도 burst 뒤 debt를 해소하는 동안 tail latency와 공간이 커질 수 있다. level별 backlog, stall 시간과 회복 시간까지 본다. compaction thread를 늘리면 foreground I/O와 CPU를 더 경쟁할 수 있다.

## 정리

- B+트리는 높은 fan-out과 연결된 leaf로 point·range·order 접근을 제공하며 split과 page maintenance 비용을 낸다.
- hash index는 equality에 집중하고 key 순서를 포기하며 bucket skew·resize 경계를 가진다.
- LSM은 random write를 memtable·sorted run으로 모으지만 여러 run read와 compaction write·space amplification을 만든다.
- clustered·unclustered와 primary·secondary는 같은 축이 아니며 실제 data lookup 단계를 확인해야 한다.
- 복합 인덱스는 predicate, range와 ordering이 만드는 scan 범위로 평가하고 covering의 넓은 entry 비용까지 포함한다.
- 인덱스 변경은 read 이득만이 아니라 modified page, WAL, split·compaction, 공간과 tail latency로 검증한다.

## 확인 문제

1. `(status, created_at)` 인덱스가 있는데 `WHERE created_at >= :t`가 대부분의 인덱스를 읽는다. 가능한 이유와 제품별로 확인할 예외는 무엇인가?
2. secondary index로 1만 건을 찾은 뒤 data page read가 거의 1만에 가깝다. 어떤 배치 특성이 이 비용을 만들며 대안의 비용은 무엇인가?
3. LSM 기반 저장소의 평균 write latency는 안정적이지만 매일 같은 시각 p99가 급증한다. 어떤 상태와 counter를 같은 timeline에서 볼 것인가?
4. covering index를 추가한 뒤 heap lookup은 줄었지만 전체 쓰기 처리량이 감소했다. 이 결과가 모순이 아닌 이유를 설명하라.

<details>
<summary>정답과 해설</summary>

1. leading `status` 제약이 없어 `created_at` 값이 status 그룹마다 흩어져 있기 때문이다. 엔진이 skip scan이나 반복 probe를 지원하고 leading distinct count가 작으면 일부 범위를 건너뛸 수 있으므로 실제 계획과 읽은 leaf page를 확인한다.
2. unclustered locator가 서로 다른 data page에 흩어져 random lookup을 만든다. row 배치를 바꾸거나 covering index로 lookup을 줄일 수 있지만 재배치 유지 비용, 넓은 index, 추가 write·space amplification을 낸다.
3. flush·compaction schedule, pending compaction bytes, level별 file/overlap, compaction read/write bytes, device queue, CPU와 write stall 시간을 본다. backup이나 다른 주기 작업과 자원 경쟁도 함께 확인한다.
4. covering은 해당 읽기 경로의 data lookup을 줄이는 대신 더 넓은 leaf entry를 모든 관련 insert/update에서 유지한다. fan-out 감소, page split, WAL과 cache footprint 증가가 쓰기 처리량을 낮출 수 있다.

</details>

## 참고 자료

- [The Log-Structured Merge-Tree](https://dsf.berkeley.edu/cs286/papers/lsm-acta1996.pdf): 작은 메모리 component와 큰 디스크 component를 병합해 쓰기 비용을 바꾸는 LSM 원 논문이다.
- [PostgreSQL: Index Types](https://www.postgresql.org/docs/current/indexes-types.html): B-tree·hash를 포함한 접근 방식이 지원하는 operator와 정렬의 제품별 사례다.
- [PostgreSQL: Multicolumn Indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html): leading column, inequality와 skip scan이 scan 범위를 바꾸는 현재 공식 설명이다.
- [PostgreSQL: Index-Only Scans and Covering Indexes](https://www.postgresql.org/docs/current/indexes-index-only-scans.html): covering 조건과 MVCC visibility 때문에 heap 접근이 남는 경계를 설명한다.
- [MySQL 8.4: InnoDB Indexes](https://dev.mysql.com/doc/refman/8.4/en/innodb-indexes.html): clustered leaf와 secondary index가 primary key를 locator로 사용하는 구체적 구현을 확인한다.
