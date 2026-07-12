# 11.3 질의 처리와 실행 계획 — 선언적 SQL을 물리 비용으로 번역한다

SQL은 원하는 결과를 선언하지만 페이지를 어떤 순서로 읽고 행을 어떻게 조인할지는 지정하지 않는다. DBMS는 의미가 같은 여러 계획 중 통계와 비용 모델로 하나를 고른다. 실행 계획 진단의 핵심은 노드 이름이 아니라 추정 행과 실제 행, 반복 횟수, 페이지·메모리·spill·대기를 따라 최초의 오판과 지배 비용을 찾는 것이다.

## 학습 목표

- parse·bind·rewrite와 논리·물리 계획의 책임 경계를 설명한다.
- scan·sort·aggregate와 nested-loop·hash·merge join의 입력 조건과 비용을 비교한다.
- iterator와 vectorized 실행이 함수 호출·메모리 지역성·materialization에서 교환하는 비용을 설명한다.
- 통계·선택도·카디널리티 오차가 접근 경로·조인 순서·알고리즘 선택으로 증폭되는 과정을 진단한다.
- 실행 계획에서 estimate/actual, `rows × loops`, buffer/page, spill과 wait를 구분한다.

## 배경: SQL에는 실행 순서가 적혀 있지 않다

다음 질의는 VIP 고객의 최근 결제 완료 주문 금액을 집계한다.

```sql
SELECT c.region, SUM(o.total_amount)
FROM customers AS c
JOIN orders AS o ON o.customer_id = c.customer_id
WHERE c.segment = 'VIP'
  AND o.status = 'PAID'
  AND o.created_at >= :since
GROUP BY c.region;
```

DBMS는 `FROM`에 쓴 순서대로 반드시 실행하지 않는다. `customers`의 VIP를 먼저 찾을 수도 있고, 최근 `PAID` 주문을 먼저 좁힐 수도 있다. 각 고객마다 index probe를 반복하거나 한 입력으로 hash table을 만들 수 있다. 정렬한 두 입력을 merge할 수도 있다. 결과는 같아야 하지만 중간 행 수와 page I/O는 크게 다르다.

가능한 계획 수는 join relation 수가 늘면서 급격히 커진다. optimizer는 모든 기계 상태에서 완벽한 계획을 찾는 예언자가 아니라 제한된 탐색 공간, 샘플 통계와 근사 비용 안에서 좋은 계획을 고르는 시스템이다. 실행 계획은 정답지가 아니라 **선택 당시의 가정과 실행 결과를 비교하는 증거**다.

## SQL에서 계획으로

### parse — 문법 구조를 만든다

parser는 token을 문법에 맞는 구문 트리로 만든다. `status`가 실제 열인지, 비교 타입이 호환되는지는 아직 catalog 문맥이 필요할 수 있다.

### bind — 이름과 타입을 실제 객체에 연결한다

binder 또는 analyzer는 table·column·function 이름을 catalog 객체에 연결하고 타입 변환, scope와 권한을 확인한다. prepared statement의 parameter type도 이후 가능한 operator와 index 선택에 영향을 줄 수 있다.

### rewrite — 의미를 보존해 표현을 바꾼다

view 확장, constant folding, predicate simplification·pushdown과 subquery decorrelation 같은 변환이 이 단계 또는 optimizer 내부에서 일어날 수 있다. 제품마다 rewrite와 optimization의 경계는 다르다. 중요한 계약은 결과 의미를 보존하면서 더 넓은 물리 선택을 가능하게 한다는 것이다.

```text
SQL
 └─ parse tree
     └─ bound/rewritten relational expression
         └─ logical plan: select · project · join · aggregate
             └─ physical plan: index scan · hash join · sort aggregate
```

논리 계획은 **무엇을 계산하는가**, 물리 계획은 **어떤 알고리즘과 접근 경로로 계산하는가**에 답한다.

## 물리 연산자의 비용 모델

### scan

| 접근 | 잘 맞는 조건 | 주요 비용·경계 |
|---|---|---|
| sequential/full scan | 큰 비율의 행, 연속 page, 작은 table | 모든 page를 읽지만 random lookup을 피함 |
| index scan | 작은 범위, ordering 활용 | tree+leaf+data lookup, 낮은 clustering이면 random I/O 증가 |
| bitmap형 접근 | 여러 index 결과 또는 중간 선택도 | locator를 모아 data page 순서로 읽지만 bitmap memory·recheck 비용 |

선택도(selectivity)는 predicate를 통과하는 비율이다. 선택도가 낮다는 표현은 문헌마다 “결과 비율이 낮다/조건이 잘 구분한다”가 섞이므로 이 문서에서는 가능한 한 예상 행 수와 비율을 직접 쓴다.

### sort와 aggregate

sort는 입력을 모두 받아야 첫 결과를 낼 수 있는 blocking operator인 경우가 많다. 입력이 memory budget을 넘으면 run을 임시 저장소에 쓰고 merge한다. `LIMIT`가 있으면 top-N algorithm을 쓸 수 있고 이미 index order가 맞으면 sort 자체를 생략할 수 있다.

aggregate는 대표적으로 두 구현이 있다.

- hash aggregate는 group key의 hash table을 만들며 입력 순서가 필요 없지만 distinct group과 상태가 memory를 넘으면 partition/spill한다.
- sort/stream aggregate는 group key 순서가 필요하지만 정렬된 입력에서는 작은 현재 상태로 순차 집계할 수 있다.

“hash가 O(n)이므로 항상 sort보다 낫다”는 결론은 memory, row width, ordering의 후속 활용과 spill을 빠뜨린다.

### nested-loop join

```text
for each outer row:
  probe matching inner rows
```

outer가 작고 inner join key에 효율적인 index가 있으면 매우 강하다. 반대로 outer 추정이 100인데 실제 100만이면 inner probe가 100만 번 반복된다. 계획에 표시된 inner node의 `loops`가 핵심 증거다.

대략적인 작업량은 다음처럼 본다.

```text
outer cost + outer rows × inner probe cost
```

cache hit와 batched lookup이 실제 비용을 완화할 수 있지만 곱셈 구조는 남는다.

### hash join

한 입력으로 hash table을 build하고 다른 입력을 probe한다. equality join에 적합하며 일반적으로 작은 입력을 build 쪽에 두는 편이 memory에 유리하다.

```text
build side → hash table
probe side → h(key)로 후보 bucket 탐색 → equality 확인
```

build가 memory를 넘으면 partition을 임시 저장소에 쓰는 multi-batch 실행이 될 수 있다. skewed key는 특정 bucket·partition을 크게 만들 수 있다. 실제 행 수뿐 아니라 row width와 hash memory·batch 수를 본다.

### merge join

두 입력이 join key 순서라면 현재 key 범위를 나란히 전진하며 equality·일부 range 조건을 처리할 수 있다. 입력이 index order를 제공하지 않으면 sort 비용이 앞에 붙는다. 정렬 결과를 이후 `ORDER BY`나 aggregate가 재사용하면 전체 계획에서는 이득일 수 있다.

| join | 강한 조건 | 급락 경계 |
|---|---|---|
| nested-loop | 작은 outer, 싼 inner probe | outer underestimate, random lookup 반복 |
| hash | equality, build가 memory에 적합 | build underestimate, skew, spill |
| merge | 두 입력이 정렬됨·range 활용 | sort 비용, 중복 key의 큰 match group |

## 실행 모델: 한 행씩 당길 것인가, 묶어서 처리할 것인가

전통적인 iterator 또는 Volcano 모델은 각 operator가 `next()`로 다음 tuple을 요청한다.

```text
Aggregate.next()
  → Join.next()
      → Scan.next()
```

operator 조합과 pipelining이 단순하고 중간 결과 전체를 materialize하지 않아도 된다. 그러나 행마다 virtual/function call, branch와 tuple interpretation 비용을 낼 수 있다.

vectorized execution은 여러 값을 batch/vector로 전달해 함수 호출을 줄이고 CPU cache와 SIMD 활용 기회를 높인다. columnar layout과 특히 잘 맞지만 batch buffer, selection vector와 variable-length 값 처리 비용이 생긴다. 아주 작은 OLTP point query에서는 setup 비용이 이득보다 클 수 있다.

materialization은 중간 결과를 memory나 storage에 완전히 저장한다. 반복 사용과 pipeline 경계를 단순화하지만 쓰고 다시 읽는 비용을 만든다. 실제 엔진은 연산자와 workload에 따라 iterator, batch와 materialization을 섞는다.

## 통계에서 카디널리티로

### 기본 통계

optimizer는 대개 table row/page count, distinct count, null fraction, most-common values(MCV), histogram과 index clustering 같은 통계를 사용한다. 통계는 전체 데이터의 완벽한 복사본이 아니며 sample과 제한된 bucket으로 요약된다.

```text
estimated rows = input rows × estimated selectivity
```

균등 분포 가정은 `distinct(status)=4`이면 각 값이 약 25%라고 추정할 수 있지만 실제 주문은 `PAID` 85%, `FAILED` 1%일 수 있다. histogram과 MCV가 이 skew를 일부 표현한다.

### 독립성 가정이 깨지는 상관 데이터

`segment='VIP'`가 5%, `status='MANUAL_REVIEW'`가 1%라고 하자. 독립으로 보면 둘의 교집합은 0.05%다.

```text
P(VIP ∧ REVIEW) ≈ P(VIP) × P(REVIEW) = 0.05 × 0.01
```

그러나 정책상 review 주문 대부분이 VIP라면 실제 교집합은 훨씬 크다. 단일 열 통계를 각각 정확히 알아도 열 사이 관계를 놓치면 join 전 입력을 과소 추정한다. multivariate/extended statistics를 지원하는 엔진은 dependency, joint MCV 또는 distinct 조합을 표현할 수 있지만 모든 predicate와 표현식을 자동으로 해결하지는 않는다.

### 오차는 계획 위쪽으로 증폭된다

leaf scan의 10배 오차가 join을 거치며 1,000배 중간 결과 오차가 될 수 있다. 이 오차는 다음 결정을 바꾼다.

- index scan 대 full scan
- join 순서
- nested-loop 대 hash/merge
- build side 선택
- sort/hash memory 예상과 parallelism

따라서 최상위의 느린 node만 보지 않고 계획 아래에서 위로 올라가며 **추정과 실제가 처음 크게 갈라지는 노드**를 찾는다.

## 비용은 시간이 아니다

cost 숫자는 엔진이 page I/O, CPU와 병렬 작업을 비교하기 위해 사용하는 내부 단위다. `cost=100`이 100ms라는 뜻이 아니다. estimated startup cost는 첫 row 전에 드는 비용, total cost는 계획이 예상한 모든 row를 소비할 때의 누적 비교값을 나타낼 수 있지만 구체적 의미는 제품 문서를 따라야 한다.

비용 모델의 상수는 저장 장치, cache와 CPU를 근사한다. stale statistics뿐 아니라 다음 경우에도 선택이 어긋날 수 있다.

- 장치 특성과 cost parameter가 다르다.
- prepared/generic plan이 parameter별 skew를 놓친다.
- 동시 workload가 memory와 I/O를 경쟁하지만 단일 query cost에 충분히 반영되지 않는다.
- UDF·expression·remote access 비용이 부정확하다.
- 탐색 공간 제한 때문에 더 좋은 join order를 고려하지 못한다.

hint로 계획을 고정하기 전에 어떤 모델 입력이 틀렸는지 찾는 이유다. hint는 당장의 회귀를 막을 수 있지만 데이터 분포가 바뀌면 새로 나쁜 계획이 될 수 있다.

## 실행 계획 판독 절차

### 0. 안전하게 실제 실행 여부를 결정한다

plain `EXPLAIN`은 대개 실행하지 않고 추정 계획을 보여 주지만 `EXPLAIN ANALYZE` 계열은 실제 statement를 실행한다. 쓰기 statement, lock을 오래 잡는 query와 운영 데이터에서는 transaction rollback, replica, 제한된 parameter 등 안전장치를 먼저 정한다. 엔진별 동작을 공식 문서에서 확인한다.

### 1. 환경과 입력을 기록한다

엔진·버전, schema·index, parameter 값, 통계 수집 시점, 데이터 크기·분포, cache 상태와 실행 옵션을 기록한다. 계획 text만 떼면 재현할 수 없다.

### 2. tree를 실행 방향으로 읽는다

대부분의 text plan은 들여쓰기된 child가 먼저 입력을 만든다. 그러나 표기와 시간 포함 범위는 제품별로 다르다. machine-readable JSON 등을 지원하면 자동 분석에는 이를 우선한다.

### 3. estimate와 actual을 분리한다

각 node에서 다음을 표로 만든다.

| node | estimated rows | actual rows/loop | loops | total rows 근사 | cardinality ratio |
|---|---:|---:|---:|---:|---:|
| inner probe | 1 | 3 | 50,000 | 150,000 | 3× per loop |

PostgreSQL·MySQL의 일부 출력은 actual rows/time이 loop당 평균이므로 총 작업을 보려면 `rows × loops`를 계산한다. 필터에서 제거된 행도 scan 작업량에 포함한다.

### 4. 첫 오차와 지배 비용을 분리한다

행 수 오차가 먼저인지, 행 수는 맞지만 page·spill·wait가 큰지 구분한다.

```text
estimate wrong? → statistics · skew · correlation · parameter
estimate right, many pages? → access path · clustering · row width
estimate right, spill? → memory · width · concurrency
little CPU, long elapsed? → lock · I/O · remote/replica wait
```

operator time은 child time을 포함할 수 있으므로 node 시간을 단순 합산하지 않는다. 공식 문서의 포함 범위를 확인한다.

### 5. 한 변수만 바꿔 반증한다

통계 갱신, index 추가, query rewrite, memory 변경을 한꺼번에 적용하면 원인을 알 수 없다. 예측과 반증 조건을 먼저 적고 하나씩 바꾼다.

## 최소 재현: SQLite에서 관찰 가능한 것과 없는 것

SQLite CLI의 `EXPLAIN QUERY PLAN`은 table/index scan, search와 일부 temporary B-tree 사용을 관찰하는 최소 경로다.

```sql
CREATE TABLE orders (
  order_id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX orders_customer_created
  ON orders(customer_id, created_at DESC);

EXPLAIN QUERY PLAN
SELECT order_id, status, created_at
FROM orders
WHERE customer_id = 42
ORDER BY created_at DESC
LIMIT 20;
```

측정 전에는 복합 인덱스로 `customer_id` 범위를 찾고 index order를 이용해 별도 sort가 없을 것으로 예측한다. 인덱스를 제거한 대조군에서는 table scan과 임시 정렬 구조가 나타날 수 있다. 실제 출력 문자열은 SQLite 버전에 따라 바뀔 수 있으므로 application이 text format에 의존하면 안 된다.

macOS의 SQLite CLI 3.51.0에서 위 schema를 실행해 확인한 결과는 다음과 같다. 행을 넣지 않아도 이 실험은 data 값이 아니라 schema와 접근 경로 후보를 비교한다. 첫 계획은 복합 인덱스를 탐색했고, 인덱스를 제거한 대조군은 table scan과 `ORDER BY`용 임시 B-tree를 선택했다.

```text
SEARCH orders USING INDEX orders_customer_created (customer_id=?)

SCAN orders
USE TEMP B-TREE FOR ORDER BY
```

SQLite의 이 출력만으로 PostgreSQL식 estimated/actual rows, buffer hit, spill bytes나 lock wait를 얻을 수는 없다. 공통 관찰 표에서 이 값은 `N/A`다. 다른 엔진의 숫자를 추정해 채우지 않는다.

## 실무 관점

### “인덱스를 안 탄다”에서 멈추지 않는다

결과 비율이 크거나 data page가 흩어져 있으면 full scan이 더 쌀 수 있다. 통계가 틀렸는지, optimizer 판단이 합리적인지 실제 rows와 page I/O로 구분한다.

### N+1은 단일 계획 밖의 증폭이다

각 query 계획이 빠르더라도 1개 목록 뒤 1,000개 point query를 보내면 parse/bind/execute, network round trip과 connection scheduling이 1,001번 일어난다. DB 계획 하나만 최적화하지 말고 request trace에서 query count와 total rows/pages를 합산한다. batch join은 큰 intermediate result라는 다른 비용을 낼 수 있다.

### 평균 parameter로 계획을 평가하지 않는다

`status='FAILED'`와 `status='PAID'`의 결과 비율이 크게 다르면 같은 prepared statement의 최적 접근 경로가 다를 수 있다. 대표값 하나가 아니라 빈도가 높은 값, 극단값과 generic/custom plan 정책을 비교한다.

## 정리

- parse·bind·rewrite는 SQL 의미를 확정하고 논리 계획은 계산, 물리 계획은 구현 방법을 표현한다.
- scan·join·sort·aggregate 선택은 입력 행 수, ordering, memory와 page 배치에 의존한다.
- 통계는 데이터의 근사 요약이며 skew·상관·staleness가 카디널리티 오차를 만든다.
- 카디널리티 오차는 접근 경로, 조인 순서와 spill 결정으로 증폭된다.
- 계획 cost는 시간이 아니며 actual rows도 `loops`와 함께 읽어야 총 작업량을 알 수 있다.
- 진단은 최초의 추정 오차와 page·spill·wait의 지배 비용을 구분하고 한 변수씩 반증한다.

## 확인 문제

1. nested-loop의 inner index scan이 `actual rows=2 loops=500000`으로 보인다. `rows=2`만 보고 일이 작다고 판단하면 안 되는 이유는 무엇인가?
2. `segment`와 `status` 각각의 통계는 최신이지만 두 predicate를 함께 쓸 때 100배 과소 추정한다. 어떤 가정이 깨졌고 무엇으로 검증할 것인가?
3. actual row는 estimate와 비슷한데 sort가 disk spill했다. 다음 가설을 제시하라.
4. `EXPLAIN ANALYZE UPDATE ...`를 운영 primary에서 바로 실행하면 안 되는 이유는 무엇인가?

<details>
<summary>정답과 해설</summary>

1. 일부 엔진 출력의 rows는 loop당 평균이다. 총 반환은 약 100만이고 index descent·page lookup도 50만 번 반복될 수 있다. outer cardinality 오차와 buffer/page 접근을 함께 본다.
2. 독립성 가정이 깨졌을 가능성이 크다. 실제 joint frequency를 질의하고 지원된다면 multivariate MCV/dependency 통계를 만든 뒤 estimate 변화를 비교한다. parameter나 expression 때문에 통계가 적용되지 않은 경우도 확인한다.
3. row width 또는 distinct group·sort key 폭 추정이 틀렸거나, 연산자 memory budget이 동시 query 수·설정 때문에 작을 수 있다. sort method, memory/disk bytes와 실제 width를 확인한다.
4. `ANALYZE`는 실제 statement를 실행하므로 데이터를 바꾸고 lock·WAL·I/O 부하를 만든다. 엔진의 rollback 동작과 trigger·외부 효과까지 확인하고 안전한 복제 환경이나 제한된 transaction에서 수행해야 한다.

</details>

## 참고 자료

- [Access Path Selection in a Relational Database Management System](https://dl.acm.org/doi/10.1145/582095.582099): System R이 통계와 비용으로 access path·join order를 선택한 고전 논문이다.
- [PostgreSQL: Using `EXPLAIN`](https://www.postgresql.org/docs/current/using-explain.html): cost, actual rows/time, loops, buffer와 sort/hash 정보를 읽는 공식 사례다.
- [PostgreSQL: Statistics Used by the Planner](https://www.postgresql.org/docs/current/planner-stats.html): histogram·MCV와 extended statistics가 카디널리티 추정에 쓰이는 방식을 설명한다.
- [SQLite: `EXPLAIN QUERY PLAN`](https://www.sqlite.org/eqp.html): SQLite에서 scan/search와 temporary sorting을 관찰할 때의 출력 계약과 변경 가능성을 명시한다.
- [MySQL 8.4: `EXPLAIN`](https://dev.mysql.com/doc/refman/8.4/en/explain.html): `EXPLAIN ANALYZE`의 iterator별 estimate·actual·loops와 지원 범위를 설명한다.
