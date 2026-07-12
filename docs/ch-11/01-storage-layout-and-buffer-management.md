# 11.1 저장 배치와 버퍼 관리 — 행의 비용은 페이지 경계에서 드러난다

DBMS는 논리적 행을 하나씩 디스크에서 읽지 않는다. 레코드를 고정 크기 페이지에 배치하고 페이지를 메모리 프레임으로 가져와 접근한다. 따라서 행 폭, free space, 접근 순서와 dirty page 상태가 실제 I/O를 결정하며, 같은 buffer hit ratio도 전혀 다른 지연을 만들 수 있다.

## 학습 목표

- 논리적 행이 레코드·슬롯 페이지·heap file과 record identifier로 표현되는 과정을 설명한다.
- 행 폭과 가변 길이 필드·fragmentation이 페이지 밀도와 읽기 증폭을 바꾸는 이유를 계산한다.
- buffer frame의 fetch·pin·unpin·dirty·evict·flush 상태 전이를 추적한다.
- 순차·무작위 접근, read-ahead와 DB buffer·OS page cache 중첩의 비용과 관찰 한계를 판단한다.
- page read·hit·dirty eviction을 함께 측정해 캐시 문제와 쓰기 압력을 구분한다.

## 배경: DBMS가 페이지를 관리하는 이유

저장 장치와 메모리는 서로 다른 단위와 비용으로 동작한다. 저장 장치에서 바이트 하나만 필요해도 파일 시스템과 장치는 블록 단위로 데이터를 옮기며, DBMS는 여러 레코드와 메타데이터를 묶은 페이지(page)를 기본 I/O·캐시 단위로 사용한다. 페이지 크기와 내부 형식은 제품과 저장 구조마다 다르므로 특정 크기를 보편 규칙으로 가정하면 안 된다.

페이지 추상화는 세 문제를 한 경계에서 푼다.

- 파일 안의 데이터를 안정적인 논리 주소로 찾는다.
- 여러 작은 레코드를 한 번의 I/O와 캐시 항목으로 묶는다.
- 빈 공간, 수정, 동시 접근과 복구 정보를 관리한다.

대가도 있다. 필요한 열 몇 개를 위해 넓은 행이 든 페이지 전체를 읽을 수 있고, 한 레코드의 크기가 바뀌면 같은 위치에 남지 못할 수 있다. 페이지가 캐시에 있어도 프레임을 사용할 권한이나 레코드 락을 기다릴 수 있다. 페이지 모델은 저장 장치의 비용을 없애는 추상화가 아니라 어디에서 비용을 지불할지 정하는 추상화다.

## 핵심 개념

### 논리적 행에서 물리 레코드로

SQL의 행(row)은 이름과 타입으로 보이는 논리 모델이다. 저장 계층은 이를 레코드 헤더, null 표시, 고정·가변 길이 필드와 정렬 padding 등을 포함한 물리 레코드(record)로 인코딩한다. 같은 스키마라도 엔진의 tuple format, 압축, MVCC metadata와 alignment에 따라 실제 크기가 다를 수 있다.

```text
logical row
  order_id = 913
  status = 'PAID'
  note = 'gift'
       │ encode
       ▼
record
  [header | null bitmap | fixed fields | offsets | variable bytes]
```

행 폭(row width)은 저장 공간만의 문제가 아니다. 페이지당 들어가는 레코드 수를 줄여 같은 행 수를 읽을 때 더 많은 페이지가 필요하게 하고, buffer pool에 남길 수 있는 행 수도 줄인다. 반대로 모든 필드를 별도 구조로 분리하면 point lookup과 갱신에 추가 조립 비용이 생길 수 있다. 정규화나 column layout의 선택은 이 챕터에서 데이터 모델링 방법론 전체가 아니라 **접근 패턴이 실제로 읽는 바이트와 페이지**라는 경계에서 다룬다.

### 슬롯 페이지는 레코드 이동과 식별을 분리한다

가변 길이 레코드를 페이지 앞에서부터 연속으로 쌓으면 중간 레코드가 커지거나 삭제될 때 뒤의 모든 위치가 바뀐다. 전형적인 슬롯 페이지(slotted page)는 페이지 헤더 뒤에 슬롯 배열을 두고 레코드 바이트를 반대쪽에서 채운다.

```text
낮은 offset                                                    높은 offset
┌──────────┬──────────────┬──────── free space ────────┬───────────────┐
│ page hdr │ slot 0 1 2 … │                            │ record bytes  │
└──────────┴──────────────┴────────────────────────────┴───────────────┘
              │                                              ▲
              └──────── offset · length ─────────────────────┘
```

record identifier(RID)를 `(page_id, slot_id)`처럼 표현하면 페이지 안에서 레코드 바이트를 압축 이동해도 slot이 새 offset을 가리킬 수 있다. 그러나 이것은 모든 엔진이 외부에 같은 형태의 영구 RID를 노출한다는 뜻이 아니다. 행 이동 시 forwarding pointer를 남기거나 보조 인덱스를 갱신하는 등 제품별 선택이 다르다.

슬롯의 상태를 단순화하면 다음과 같다.

```text
FREE → OCCUPIED(offset, length)
             │ delete
             ▼
          DEAD/FREE

record bytes는 compaction으로 이동할 수 있지만 slot_id는 유지할 수 있다.
```

삭제된 공간이 있다고 새 레코드를 항상 넣을 수 있는 것은 아니다. 총 free bytes는 충분해도 연속 공간이 부족할 수 있고, 레코드 크기가 페이지 한도를 넘을 수 있다. 엔진은 페이지 내부 compaction, overflow page, out-of-line large object 또는 다른 페이지로의 이동 중 하나를 선택한다.

### heap file은 페이지 집합과 빈 공간을 관리한다

heap file은 여기서 정렬되지 않은 레코드 페이지 집합이라는 일반적 모델을 뜻한다. 새 레코드를 넣으려면 충분한 빈 공간이 있는 페이지를 찾아야 한다. 모든 페이지를 선형 탐색하면 삽입 비용이 파일 크기에 따라 커지므로 free-space map, page directory 또는 extent metadata 같은 보조 구조를 둔다.

```text
heap relation
  ├─ page 41: free 12%
  ├─ page 42: free 37%  ← insert candidate
  ├─ page 43: free  3%
  └─ page 44: free 61%  ← insert candidate
```

빈 공간을 거의 남기지 않으면 초기 scan 밀도는 높아지지만 가변 길이 update가 다른 페이지로 이동하거나 page split·forwarding을 유발할 가능성이 커진다. 여유 공간을 남기면 update의 국소성을 얻는 대신 더 많은 페이지를 읽는다. 적절한 비율은 “OLTP라서 10%” 같은 보편 숫자가 아니라 레코드 크기 분포와 update 패턴에 달려 있다.

### 행 배치와 열 배치의 경계

행 지향(row-oriented) 배치는 한 행의 여러 필드를 가까이 두므로 주문 한 건을 조회·갱신하는 접근에 유리하다. 열 지향(column-oriented) 배치는 같은 열의 값을 가까이 두어 많은 행에서 일부 열만 읽는 집계와 압축에 유리하다.

| 접근 | 행 배치에서의 경향 | 열 배치에서의 경향 |
|---|---|---|
| 한 주문의 모든 필드 조회 | 필요한 값이 적은 페이지에 모임 | 여러 column segment를 조립할 수 있음 |
| 백만 주문의 `status` 집계 | 넓은 행의 불필요한 열도 함께 읽음 | 필요한 열만 scan·압축 해제 가능 |
| 한 주문의 여러 열 갱신 | 한 레코드 주변에서 수정 | 여러 열 구조의 변경을 조정할 수 있음 |

현대 제품은 순수한 두 극단만 갖지 않는다. row group, column family, compression block과 delta store를 조합한다. 따라서 제품 이름 대신 실제 읽는 단위, projection, update path와 compaction 경계를 확인해야 한다.

## 버퍼 풀의 상태 모델

버퍼 풀(buffer pool)은 디스크 페이지를 담는 고정 수 또는 제한된 수의 메모리 프레임(frame)과 이를 찾는 page table, 교체·flush metadata로 구성할 수 있다.

```text
page table: page_id → frame_id

frame
  page_id
  page bytes
  pin_count
  dirty
  replacement metadata
  I/O state
```

### fetch — 페이지를 프레임에 가져온다

`fetch(page_id)`의 단순화한 흐름은 다음과 같다.

1. page table에서 resident 여부를 찾는다.
2. 있으면 hit로 기록하고 해당 프레임을 pin한다.
3. 없으면 unpinned victim 또는 free frame을 찾는다.
4. victim이 dirty라면 복구 규칙을 만족한 뒤 먼저 flush한다.
5. 요청 페이지를 읽고 page table을 바꾼 뒤 pin한 프레임을 반환한다.

실제 엔진은 concurrent lookup, asynchronous I/O, checksum, decompression과 latch를 더 다룬다. 위 모델은 상태 전이와 비용을 구분하기 위한 의사 코드이지 특정 엔진 구현이 아니다.

```text
ABSENT
  │ fetch: allocate + read
  ▼
RESIDENT_CLEAN ── modify ──▶ RESIDENT_DIRTY
  │  ▲                         │
  │  └──────── flush ──────────┘
  │
  └─ evict (pin_count = 0) ──▶ ABSENT

어느 resident 상태든 pin_count > 0이면 일반적으로 victim으로 고를 수 없다.
```

### pin은 수명, latch는 메모리 구조, lock은 논리 데이터를 보호한다

세 개념을 섞으면 대기 원인을 잘못 찾는다.

- **pin**은 연산자가 프레임을 사용하는 동안 축출되지 않게 수명을 보호한다.
- **latch**는 페이지나 buffer metadata 같은 메모리 구조의 짧은 임계 구역을 보호한다.
- **lock**은 트랜잭션 사이에서 행·key range 같은 논리 데이터와 격리 계약을 보호하며 보통 더 오래 유지된다.

엔진에 따라 용어는 다르지만 보호 대상과 수명을 보면 구분할 수 있다. buffer hit가 100%에 가까워도 hot page latch나 row lock을 기다리면 지연은 커진다. 반대로 lock wait가 없어도 모든 frame이 pin되어 victim을 못 찾으면 buffer allocation이 막힐 수 있다.

### dirty page는 hit 이후의 쓰기 비용을 남긴다

메모리에서 페이지를 수정하면 즉시 data file에 쓰지 않고 dirty로 표시할 수 있다. 이 방식은 여러 update를 합치고 foreground I/O를 줄이지만 언젠가 flush해야 한다. buffer가 작거나 쓰기 burst가 크면 dirty victim을 재사용하기 위해 foreground가 flush를 기다릴 수 있다.

따라서 다음 두 workload는 hit ratio가 같아도 비용이 다르다.

| workload | hit | miss | dirty eviction | 예상 병목 |
|---|---:|---:|---:|---|
| A: 같은 100개 page 반복 읽기 | 99% | 1% | 0 | 대부분 메모리 읽기 |
| B: 같은 비율로 page를 hit하며 계속 수정 | 99% | 1% | 높음 | flush·WAL·write queue 가능 |

hit ratio의 분모가 logical page request라면 scan이 매우 많아 hit 수 자체가 커지는 동안 physical read도 증가할 수 있다. 비율만 보지 않고 요청률, read/write page 수와 latency를 함께 봐야 한다.

## 교체 정책과 접근 패턴

### LRU는 시간 지역성을 근사할 뿐 미래를 알지 못한다

least recently used(LRU)는 오래 접근하지 않은 페이지를 victim으로 고른다. 완전한 LRU는 metadata 갱신 경쟁이 클 수 있어 실제 엔진은 clock, segmented LRU, usage count 같은 근사를 사용한다. 제품별 정책을 보편적인 LRU로 단정하면 안 된다.

순차 scan이 buffer보다 큰 관계를 한 번 훑으면 최근 사용 목록을 scan page로 채워 자주 쓰던 hot page를 밀어낼 수 있다. 이를 scan pollution이라 한다. 엔진은 scan-resistant 영역, ring buffer 또는 read-ahead 정책으로 완화할 수 있지만 workload와 제품 설정에 따라 결과가 달라진다.

### 순차와 무작위는 장치 시간만의 차이가 아니다

HDD에서는 seek와 회전 지연 때문에 무작위 I/O의 벌점이 특히 컸다. SSD에서도 순차 접근은 요청 병합, queueing, read-ahead와 높은 전송 효율을 얻을 수 있고 무작위 작은 I/O는 더 많은 IOPS와 metadata 경로를 소비한다. 다만 고정된 “순차 I/O가 N배 빠르다”는 수치는 장치, queue depth, block size와 cache 상태 없이는 의미가 없다.

접근 순서는 상위 계층에도 영향을 준다.

- 인접 leaf를 순회하면 index range scan의 page locality를 얻는다.
- unclustered secondary index가 흩어진 heap RID를 반환하면 logical index 순서가 data page의 무작위 접근이 될 수 있다.
- prefetch가 너무 공격적이면 사용하지 않을 페이지를 읽어 대역폭과 buffer를 소비한다.

### DB buffer와 OS page cache가 겹칠 수 있다

DBMS가 buffered I/O를 사용하면 같은 파일 page가 DB buffer와 OS page cache 양쪽에 존재할 수 있다. direct I/O 계열을 사용하면 일부 중첩을 줄일 수 있지만 metadata, writeback와 정렬 제약까지 모든 OS 계층을 제거하는 것은 아니다. 어떤 경로를 쓰는지는 엔진·플랫폼·설정에 따라 다르다.

이 중첩은 측정을 어렵게 한다. DB buffer miss가 곧 물리 장치 read라는 뜻은 아니다. OS page cache에서 충족될 수 있다. 반대로 DB buffer hit여도 dirty flush와 WAL write가 장치 I/O를 만들 수 있다. 최소한 다음 층을 분리한다.

```text
logical page request
  → DB buffer hit / miss
  → OS cache hit / miss 또는 direct I/O
  → block device request
  → device completion
```

## 관찰 실험: 같은 hit ratio, 다른 비용

다음은 특정 DBMS benchmark가 아니라 버퍼 상태를 검증할 deterministic simulator의 실험 설계다. 챕터 통합 실습에서 구현할 때도 먼저 예상 결과를 기록한다.

### 조건

- page는 `0..99`, buffer는 10 frame으로 둔다.
- 교체는 교육용 exact LRU, I/O는 동기식으로 단순화한다.
- trace R은 `0..9` 순회 100회를 모두 읽기로 실행한다.
- trace W는 `0..9` 수정 순회 100회를 실행하고, hot 순회 10회마다 `10..19`를 한 번 읽는다.
- miss는 page read 1회, dirty victim은 page write 1회로 센다.

### 측정 전 예측

- R은 첫 10회 miss 뒤 모두 hit하며 dirty eviction이 없다.
- W는 hot page를 hit하는 구간이 많아 hit ratio가 높아도 cold scan이 들어올 때 dirty hot page를 밀어내며 write가 발생한다.
- buffer를 20 frame으로 늘리면 W의 hot·cold working set이 함께 들어가 dirty eviction이 크게 줄어든다.

반증 조건은 W에서도 dirty eviction이 0이거나, buffer 20에서 같은 반복 구간의 eviction이 계속되는 것이다. 그 경우 simulator의 pin 해제, LRU 갱신 또는 dirty 상태 전이를 점검해야 한다.

### 기록할 표

| trace | frames | requests | hits | page reads | page writes | dirty evictions |
|---|---:|---:|---:|---:|---:|---:|
| R | 10 | 1,000 | 990 | 10 | 0 | 0 |
| W | 10 | 1,100 | 900 | 200 | 100 | 100 |
| W | 20 | 1,100 | 1,080 | 20 | 0 | 0 |

이 결과는 Node.js 24.14.0에서 page table과 exact LRU를 `Map`으로 표현한 동기식 simulator로 검증했다. 실험 종료 시 남은 dirty page의 최종 flush는 세지 않고, victim으로 선택된 dirty page의 write만 기록했다. 따라서 W/20의 page write 0은 내구성 있는 저장이 필요 없다는 뜻이 아니라 이 trace 동안 dirty eviction이 없었다는 뜻이다. 구현은 성능 benchmark가 아니라 상태 전이 검증용이다.

실제 DBMS에서 비교할 때는 simulator의 counter를 엔진 지표와 동일시하지 않는다. 예를 들어 InnoDB는 buffer pool page read·write, dirty page와 pending flush를 제공하지만 exact LRU victim 순서를 외부에서 모두 관찰할 수 있는 것은 아니다. PostgreSQL의 shared buffer 관찰과 OS cache 관계도 같은 이름·단위가 아니다. 공통 표에 없는 지표는 `N/A`로 둔다.

## 실무 관점

### hit ratio만 높이면 해결된다는 오해

hit ratio가 낮은 원인이 working set 초과인지, 일회성 scan인지, 쓸모없는 read-ahead인지 먼저 구분한다. 무조건 buffer를 키우면 OS와 다른 프로세스의 메모리를 압박해 paging을 만들 수 있고 재시작 후 warm-up 시간도 길어진다. 비율 대신 page request rate, miss가 만든 실제 device I/O, dirty flush와 latency를 함께 본다.

### 넓은 행을 `SELECT *` 탓으로만 돌리지 않는다

projection을 줄이면 executor와 네트워크에서 이동하는 바이트는 줄 수 있다. 하지만 row store가 여전히 같은 heap page를 읽는다면 storage page read 수는 그대로일 수 있다. covering index나 columnar projection은 다른 구조와 쓰기 비용을 추가한다. 어느 계층의 바이트가 줄었는지 측정해야 한다.

### fragmentation은 하나의 숫자가 아니다

페이지 내부 free space, dead version, index leaf의 낮은 fill, 파일의 비연속 extent는 서로 다른 현상이다. 모두 “fragmentation”이라고 부르면 적절한 조치가 달라진다. 먼저 어떤 레벨의 빈 공간과 추가 I/O를 측정했는지 명시한다.

### cold cache와 warm cache 결과를 섞지 않는다

재현 실험은 DB buffer, OS cache와 storage cache 중 무엇을 초기화했는지 기록한다. 운영 시스템에서 cache drop은 위험하고 다른 workload를 교란할 수 있으므로 무조건 수행하지 않는다. 대신 첫 실행과 반복 실행을 분리하고 engine counter로 어느 층의 miss가 달라졌는지 관찰한다.

## 더 깊이: 페이지 크기는 왜 크게만 만들지 않는가

큰 페이지는 한 번의 I/O로 더 많은 인접 레코드를 가져오고 page table·tree height의 overhead를 줄일 수 있다. 그러나 point lookup에서는 불필요한 바이트를 더 읽고, 작은 update도 더 큰 dirty unit과 write amplification을 만들 수 있다. buffer frame 하나가 차지하는 공간도 커져 서로 다른 hot page를 담을 수 있는 수가 줄어든다.

작은 페이지는 세밀한 캐시와 update 단위를 제공하지만 metadata와 tree fan-out, I/O 요청 수가 늘 수 있다. 압축 block, filesystem block과 device sector의 정렬도 영향을 준다. 페이지 크기는 장치 하나의 최적값이 아니라 access pattern, record width, compression과 recovery 단위를 함께 묶는 설계 결정이다.

## 정리

- 논리적 행은 metadata를 포함한 레코드로 인코딩되어 슬롯 페이지와 파일에 배치된다.
- `(page_id, slot_id)` 같은 간접 식별은 페이지 안의 레코드 이동과 논리 주소를 분리한다.
- 행 폭, free space와 fragmentation은 페이지당 레코드 수와 실제 page read를 바꾼다.
- buffer manager는 fetch·pin·dirty·evict·flush 상태를 관리하며 dirty victim은 hit ratio에 보이지 않는 쓰기 비용을 만든다.
- DB buffer miss, OS cache miss와 device read는 같은 사건이 아니므로 관찰 층을 구분해야 한다.
- 교체 정책과 page 크기에는 보편 최적값이 없으며 working set, 접근 순서와 update 비율로 판단한다.

## 확인 문제

1. 주문 테이블의 평균 행 폭이 두 배가 된 뒤 행 수와 쿼리는 그대로인데 full scan의 page read가 늘었다. 이 현상을 슬롯 페이지 모델로 설명하라.
2. 두 서버의 buffer hit ratio가 모두 99%인데 한 서버만 쓰기 지연이 크다. 다음으로 비교할 counter와 상태는 무엇인가?
3. DB buffer miss 수가 1만이라고 측정했다. 이를 곧바로 물리 디스크 read 1만 회라고 보고할 수 없는 이유는 무엇인가?
4. 긴 sequential scan 뒤 point lookup p99가 잠시 증가했다. buffer 크기를 늘리기 전에 검증할 가설을 제시하라.

<details>
<summary>정답과 해설</summary>

1. 레코드 header와 필드를 포함한 물리 폭이 커지면 페이지당 들어가는 레코드 수가 줄어든다. 같은 행 수를 scan해도 더 많은 페이지가 필요하며 가변 길이 update나 빈 공간 분포까지 바뀌었다면 증가 폭은 단순 두 배와 다를 수 있다.
2. logical page request rate와 page read뿐 아니라 dirty page 수·비율, page writes, pending/background flush, dirty eviction, WAL bytes·fsync latency와 device write queue를 비교한다. hit한 페이지를 수정한 뒤 내보내는 비용은 hit ratio에 드러나지 않는다.
3. buffered I/O 경로라면 DB buffer에서 빠진 페이지가 OS page cache에서 충족될 수 있고 read-ahead가 한 요청으로 여러 페이지를 가져올 수도 있다. DB page 크기와 device request 단위도 다르다. DB counter와 OS·block device 관찰을 연결해야 한다.
4. scan이 hot page를 교체한 scan pollution, read-ahead한 미사용 page가 buffer를 차지한 경우, scan과 point lookup의 I/O queue 경쟁을 검증한다. scan-resistant 정책이나 별도 실행 시간대가 더 적절할 수 있다.

</details>

## 참고 자료

- [PostgreSQL: Database Page Layout](https://www.postgresql.org/docs/current/storage-page-layout.html): PostgreSQL heap page의 header, item identifier와 tuple 배치를 슬롯 페이지의 구체적 사례로 확인한다.
- [SQLite Database File Format](https://www.sqlite.org/fileformat.html): SQLite의 page 기반 파일, B-tree page와 overflow page 형식을 설명하는 공식 문서다.
- [MySQL 8.4: InnoDB Buffer Pool](https://dev.mysql.com/doc/refman/8.4/en/innodb-buffer-pool.html): InnoDB의 page, LRU 변형, dirty page와 read-ahead가 일반 buffer 모델을 어떻게 구체화하는지 확인한다.
- [MySQL 8.4: `INNODB_BUFFER_POOL_STATS`](https://dev.mysql.com/doc/refman/8.4/en/information-schema-innodb-buffer-pool-stats-table.html): page read·write, dirty page, pending I/O와 read-ahead 등 관찰 가능한 counter의 의미를 제공한다.
- [Architecture of a Database System](https://doi.org/10.1561/1900000002): storage manager와 buffer pool이 DBMS 전체 실행 경로에서 맡는 역할과 구현 대안을 설명한다.
