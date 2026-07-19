# 챕터 8a 기획 — 경쟁 상태와 동기화

[ROADMAP.md](../ROADMAP.md)의 챕터 8a(`docs/ch-8a/`, 인트로 1편과 본문 2편)를 집필하기 위한 상세 기획이다.
범위·경로가 ROADMAP과 어긋나면 ROADMAP을 우선한다.

## 1. 챕터의 관점

독자는 5년차 이상 개발자다. 멀티스레드 서버나 비동기 코드를 작성해 왔고, "만 번에 한 번 실패하는 테스트"나 "프로덕션에서만 재현되는 버그"를 겪어 봤다. 그러나 그 버그를 우연이 아니라 **가능한 실행들의 집합**으로 설명하는 모델이 없으면, 로그를 넣어 보고 sleep을 조정하는 추측 대응에서 벗어나지 못한다.
이 챕터는 동시성 API의 카탈로그가 아니라 **"동시 실행의 결과 공간을 열거하고, 동기화가 그 공간을 어떻게 제한하며 얼마를 청구하는지 판단하는 능력"**을 세운다. 더하는 것은 세 가지다.

1. **실행 모델** — interleaving 모델로 "코드는 하나인데 실행은 여럿"임을 세우고, race window를 식별해 가끔만 실패하는 버그를 재현·탐지 가능한 대상으로 바꾼다.
2. **계약** — data race와 race condition을 구분하고, happens-before라는 언어·런타임의 약속을 근거로 어떤 실행 결과가 허용되는지 판단한다.
3. **비용** — mutex·조건 변수·atomic이 각각 무엇을 보장하고 경합 수준에 따라 얼마를 청구하는지 측정해, 불변식 보호와 성능 사이의 트레이드오프를 판단한다.

위치는 챕터 7(캐시 일관성·false sharing이라는 하드웨어 층)과 챕터 11의 04(트랜잭션 동시성 제어라는 DB 층) 사이다. 하드웨어가 보장을 멈추는 지점에서 시작해, DB가 같은 문제의식을 일반화하기 전까지 — 스레드와 공유 메모리 수준 — 을 담당한다.

## 2. 범위 결정

### 다루는 것

- interleaving 실행 모델, 원자성의 단위(소스 한 줄 ≠ 원자적 연산), 임계 구역과 불변식, race window
- data race(동기화 없는 동시 접근이라는 메모리 모델 위반)와 race condition(원자성·순서 위반이라는 논리 오류)의 구분 — 교집합과 각각만 성립하는 사례
- 전형 패턴: read-modify-write 소실, check-then-act(TOCTOU), 지연 초기화
- 재현·탐지: 스트레스 테스트와 스케줄 교란, ThreadSanitizer의 happens-before 기반 탐지 원리와 한계(실행된 interleaving만 검증)
- 동기화 프리미티브: mutex와 락 범위, 조건 변수와 spurious wakeup, 세마포어·rwlock, atomic 연산과 CAS — 지켜야 할 불변식을 기준으로 선택하는 관점
- happens-before와 언어 메모리 모델의 공통 계약(data-race-free 프로그램은 순차 일관처럼 보인다 — DRF-SC), 동기화 없는 플래그 신호가 깨지는 이유
- futex 구조: 비경합 락이 싼 이유(유저 공간 CAS), 경합 락이 비싼 이유(스핀→블로킹 전환과 컨텍스트 스위치 — ch-8 01 회수)
- 락 순서 규율과 데드락, 락 granularity와 샤딩, 경합 수준별 비용 곡선
- lock-free의 존재와 경계 — 무엇을 얻고 무엇이 어려운지(직접 구현은 범위 밖)
- 단일 스레드 이벤트 루프에서 data race 없이 race condition만 남는 사례(await 경계의 상태 변화)

### 위임하는 것 (문서에 위임 지점을 명시한다)

| 주제 | 위임 대상 | 챕터 8a에서의 취급 |
|------|-----------|------------------|
| 캐시 일관성 프로토콜·false sharing·하드웨어 재정렬 | ch-7 `02-memory-hierarchy.md` | 하드웨어 층은 링크로 재사용. 이 챕터는 그 위의 언어·OS 층 계약(happens-before)을 담당 |
| 스레드·컨텍스트 스위치·스케줄링 모델 | ch-8 `01-processes-and-scheduling.md` | "경합에 진 스레드가 잠든다"의 스위치 비용 산정은 링크 재사용 |
| 분산 환경의 락·합의·순서(논리 시계) | ch-10 | 단일 머신 공유 메모리까지만. 여러 프로세스·머신의 경쟁은 문장으로 예고 |
| 트랜잭션 동시성 제어(2PL·MVCC·격리 수준·DB deadlock) | ch-11 `04-transactions-and-concurrency-control.md` | 같은 문제의식(불변식 보호)이 DB에서 일반화되는 지점을 연결만 |
| 파일시스템 TOCTOU의 커널·권한 상세 | ch-8 | check-then-act의 사례 이름으로만 사용 |

### 다루지 않기로 결정한 것

- **lock-free 자료구조 구현(ABA 문제, hazard pointer, epoch reclamation)은 하지 않는다.** 존재와 위험 경계, "검증된 라이브러리를 쓴다"는 판단 기준까지만.
- **언어별 메모리 모델 명세의 세부는 다루지 않는다.** C++ `memory_order` 6종 열거가 아니라 acquire/release·seq_cst 수준의 공통 모델까지만. 언어별 차이는 표 하나로 정리한다.
- **async/await·코루틴 스케줄링의 런타임 구현은 다루지 않는다.** 단일 스레드에서도 race condition이 남는다는 사례까지만 (이벤트 루프 구조는 ch-8 03).
- **데드락 회피·복구 알고리즘(banker's algorithm 등)은 다루지 않는다.** 락 순서 규율과 wait-for 관점의 진단까지만. DB의 deadlock 탐지는 ch-11 04가 담당한다.
- **형식 검증·모델 체킹(TLA+, loom 계열 도구)은 이름과 용도만.**

## 3. 문서별 상세 기획

본문 2편은 콘텐츠 집필 지침의 기본 구조(학습 목표 → 배경 → 핵심 개념 → 실무 관점 → 더 깊이 → 정리 → 확인 문제 → 참고 자료)를 따르고, 45~90분 분량으로 작성한다. 00 인트로는 10~15분 분량의 오리엔테이션으로 구성한다.

### `00-introduction.md` — 가끔만 실패하는 코드

- **핵심 질문**: 왜 이 버그는 만 번에 한 번만, 그것도 프로덕션에서만 나타나는가?
- **도입 사례**: 재고 차감(또는 중복 주문 방지) 로직이 테스트를 전부 통과하고도 부하가 걸린 프로덕션에서 간헐적으로 불변식을 깨는 장애 상황으로 시작한다. 로그를 추가하자 재현이 사라지는(heisenbug) 현상까지 제시해 "타이밍이 결과를 바꾼다"는 문제의식을 세운다.
- **핵심 관점**: 동시성 버그는 코드 한 곳이 아니라 **가능한 실행들의 집합**에 있다. 순차 실행 직관이 만드는 착시를 걷어내고, 실행 공간을 모델로 다뤄야 재현·수정·예방이 가능해진다.
- **실무 연결**: 간헐 장애 진단, 동시 요청 처리 설계, "테스트 통과"가 보장하는 것의 경계라는 세 순간에 이 모델이 필요한 이유를 설명한다.
- **학습 지도**: 01은 "어떤 실행들이 가능하고 무엇이 잘못되는가", 02는 "가능한 실행을 어떻게 제한하고 그 비용은 얼마인가"라는 질문으로 연결한다.
- **범위 경계**: 용어와 프리미티브를 미리 가르치지 않는다. interleaving·data race·mutex의 정의는 본문에 위임한다.

### `01-race-conditions-and-interleaving.md` — 실행은 하나가 아니다

- **핵심 질문**: `counter++`는 왜 사라지는가? 가능한 실행 결과를 어떻게 열거하고, 어떻게 재현·탐지하는가?
- **핵심 개념 뼈대**
  - interleaving 모델: 스레드별 연산 순서는 유지되고 스레드 간 순서는 임의로 섞인다는 기본 모델, 실행 공간의 크기
  - 원자성의 단위: 소스 한 줄이 read-modify-write 세 연산으로 갈라지는 지점, 갱신 소실(lost update)의 발생 구조
  - check-then-act: 검사와 행동 사이의 race window, TOCTOU라는 이름, 지연 초기화·중복 생성 사례
  - 임계 구역과 불변식: "무엇을 보호하는가"를 코드 블록이 아니라 불변식으로 정의하는 관점
  - data race vs race condition: 정의(동기화 없는 동시 접근 vs 타이밍 의존 논리 오류), 교집합과 차집합 사례, data race가 언어 계약(UB·임의 동작)을 깨는 이유
  - 왜 가끔만 실패하는가: race window 크기와 확률, 로그·디버거가 타이밍을 바꿔 재현을 없애는 구조
  - 재현·탐지: 스트레스 테스트(스레드 수·반복 수 증폭), 의도적 지연 주입으로 window 확대, ThreadSanitizer의 happens-before 추적 원리와 한계(실행된 경로만 검증, 커버리지 아님)
- **실무 연결**: 중복 요청·중복 결제 처리, 한 번만 실행 보장(once), "만 번 통과한 테스트"가 race 부재를 증명하지 못하는 이유, 이벤트 루프 코드에서 await 경계로 상태가 바뀌는 race condition
- **관찰 예제**: (1) worker_threads + SharedArrayBuffer 카운터 소실 재현 — 반복 수에 따른 소실률 관찰(ch-7 02의 `Atomics.add` 예제와 연결), (2) C + pthread 동일 재현을 ThreadSanitizer로 검출하고 보고서 읽기
- **경계 조건**: 단일 스레드 이벤트 루프에서 data race 없이 race condition만 남는 사례, TSan이 잡지 못하는 race condition(동기화는 있으나 논리가 틀린 경우)

### `02-synchronization-and-memory-models.md` — 실행을 제한하는 계약과 비용

- **핵심 질문**: 락은 무엇을 보장하고 얼마를 청구하는가? 동기화 없이 플래그 변수로 신호를 보내면 왜 깨지는가?
- **핵심 개념 뼈대**
  - mutex와 상호 배제: 임계 구역의 직렬화, 락 범위를 불변식 단위로 정하는 기준(넓으면 직렬화 비용, 좁으면 불변식 노출)
  - 조건 변수: 상태 대기의 표준 패턴, spurious wakeup과 `while` 재검사가 계약인 이유, 세마포어·rwlock의 자리
  - atomic과 CAS: 단일 변수의 원자적 read-modify-write, atomic만으로 여러 불변식을 묶지 못하는 한계
  - happens-before: 동기화 연산이 만드는 가시성·순서 보장, 락 해제→획득·atomic 쓰기→읽기가 잇는 관계
  - 언어 메모리 모델: 동기화 없는 플래그 폴링이 컴파일러·하드웨어 재정렬로 깨지는 구조(ch-7 02의 하드웨어 층 위임 회수), DRF-SC라는 공통 계약, 언어별 도구의 대응 표(C/C++ atomic, Java volatile/JMM, Go, JS Atomics)
  - futex와 대기 비용: 비경합 락은 유저 공간 CAS로 끝나 싸고, 경합 락은 스핀→블로킹 전환과 컨텍스트 스위치를 치른다(ch-8 01 회수)
  - 데드락: 락 순서 규율, wait-for 관점의 진단(스택 덤프에서 읽기)
  - granularity와 확장: coarse vs fine, per-thread 샤딩 후 합산, false sharing이라는 함정(ch-7 02 링크)
  - lock-free의 경계: 무엇을 얻는지(대기 없는 진행 보장)와 왜 직접 구현하지 않는지
- **실무 관점**: 락 경합 진단(프로파일에서 락 대기 읽기), double-checked locking이 요구하는 조건, 락 대신 큐·불변 데이터·소유권 이전이라는 설계 대안, "락이 느린 게 아니라 경합이 느리다"
- **관찰 예제**: (1) mutex·atomic·per-thread 샤딩 카운터의 스레드 수별 처리량 비교, (2) 락 순서가 엇갈린 데드락 재현과 스택 확인
- **경계 조건**: 락이 있어도 남는 race condition(락 밖에서 합성된 check-then-act), 경합이 심하면 atomic도 캐시 라인 핑퐁으로 느려지는 구간, 조건 변수 없이 sleep 폴링이 만드는 지연·CPU 트레이드오프

## 4. 문서 간 의존 관계

```text
00 문제의식·학습 지도 ──▶ 01 interleaving·race 모델 ──▶ 02 동기화 계약·비용
                                │                            │
                                └── ch-7 02(하드웨어 일관성),  └── ch-11 04(DB 동시성 제어)로 예고,
                                    ch-8 01(스레드 모델) 회수      ch-10(분산)은 문장 위임
```

- 00은 문제의식과 핵심 질문만 세우고 정의·원리는 01·02에 위임한다.
- 01의 interleaving 모델과 data race 정의는 02의 happens-before 논의의 전제다. 순서를 유지한다.
- 01·02는 ch-7 02(캐시 일관성·false sharing·하드웨어 재정렬)와 ch-8 01(스레드·스위치 비용)을 상대 링크로 회수한다. 두 문서 모두 존재하므로 링크로 연결한다.
- 02의 마지막은 ch-11 04(같은 불변식 보호가 트랜잭션으로 일반화)로 잇고, 분산 환경의 경쟁(ch-10)은 문장으로만 위임한다.

## 5. 실습 과제 기획 (`exercises/ch-8a/`)

ROADMAP 산출물: "카운터 소실과 check-then-act race를 재현하고 ThreadSanitizer로 data race를 검출한 뒤, mutex·atomic·per-thread 샤딩 세 구현의 경합 수준별 비용을 측정해 리포트로 정리한다."

### 환경 결정

- **언어**: race 재현·탐지 트랙은 **C(pthread)** 를 기준으로 한다. ThreadSanitizer가 언어 메모리 모델 위반을 정의대로 검출하는 환경이 필요하기 때문이다. 접근성을 위해 **Node.js worker_threads + SharedArrayBuffer** 병행 트랙을 두어 JS만으로도 소실·Atomics 대조를 재현할 수 있게 한다.
- **환경**: TSan은 macOS·Linux의 clang에서 모두 동작하므로, ch-7·ch-8 실습과 달리 **macOS에서도 대부분 수행 가능**하다. futex 관찰 등 Linux 의존 항목은 선택 확장으로 분리한다.
- **미결**: 측정 노이즈 통제(코어 고정 등)의 구체 절차는 실습 문서 작성 시점에 ch-7 실습 환경 결정과 일치시킨다.

### Part A — race 재현과 탐지

1. 공유 카운터 소실을 스레드 수·반복 수 조건별로 재현하고 소실률의 분포를 관찰한다(단정적 재현이 불가능함을 수치로 확인).
2. check-then-act(잔액 검사 후 인출) race를 재현하고 race window에 지연을 주입해 실패율이 커지는 것을 관찰한다.
3. C 구현을 TSan으로 빌드해 data race 보고서를 읽고, 동기화 추가 후 보고가 사라지는 것을 확인한다.
4. JS 트랙: `Atomics.add` 유무로 같은 소실을 재현·제거한다.

### Part B — 동기화 프리미티브 비용 측정

- **구현 3종**: (1) mutex 보호 카운터, (2) atomic 카운터, (3) per-thread 샤딩 + 최종 합산
- **측정 시나리오**: 스레드 수(1 → 코어 수 → 코어 수 초과)와 임계 구역 크기를 바꿔 가며 처리량을 기록한다.
- **분석 포인트**: 비경합 구간에서 세 구현의 차이, 경합 증가 시 mutex의 블로킹 비용과 atomic의 라인 핑퐁, 샤딩이 이기는 구조(ch-7 false sharing 함정 포함)

### 리포트와 완료 기준 초안

- 소실률·실패율 분포와 TSan 검출 결과를 제시하고, "재현 확률과 버그 존재는 별개"임을 서술한다.
- 스레드 수에 따른 구현별 처리량 곡선을 제시하고 교차 지점을 동기화 비용 모델로 설명한다.
- 실행 환경(OS, CPU, clang·Node 버전)을 명시하고 스크립트로 재현 가능해야 한다.
- 상세 완료 기준은 실습 문서 작성 시 확정한다.

## 6. 조사 노트 — 1차 자료 후보

집필 시 아래를 우선 확인하고, 언어 명세 인용은 현행 판본으로 재검증한다.

- **메모리 모델 명세**: C++ 표준의 memory model 절(cppreference로 보조), Java Language Specification §17(JMM), The Go Memory Model(공식 문서), ECMAScript의 SharedArrayBuffer 메모리 모델 절
- **원리·원 논문**: Adve & Boehm "Memory Models: A Case for Rethinking Parallel Languages and Hardware"(DRF-SC), Boehm "Threads Cannot Be Implemented as a Library", Lamport "Time, Clocks, and the Ordering of Events"(happens-before의 기원 — ch-10과 분담), Lu et al. "Learning from Mistakes"(ASPLOS 2008 — 원자성·순서 위반 분류의 근거)
- **동기화 구현**: Ulrich Drepper "Futexes Are Tricky", futex(2)·pthread_cond_wait(3) man page(spurious wakeup 규정은 POSIX 명세로 확인)
- **탐지 도구**: ThreadSanitizer 공식 문서(알고리즘·한계·플래그)
- **교재**: OSTEP 동시성 장(무료 공개 — 챕터 뼈대 보조), Herlihy & Shavit *The Art of Multiprocessor Programming*(lock-free 경계 서술의 근거)

### 통념 검증 목록 (본문에서 정면으로 다룰 것)

- "한 줄짜리 코드는 원자적이다" → `counter++`는 read-modify-write 세 연산이고, 원자성은 소스 문법이 아니라 실행 모델의 속성이다.
- "volatile을 붙이면 스레드 안전하다" → 언어마다 의미가 다르고(Java는 가시성만, C/C++은 동시성 도구가 아님), 어느 쪽도 복합 연산의 원자성을 주지 않는다.
- "락은 느리니 최대한 피해야 한다" → 비경합 락은 유저 공간 CAS 수준으로 싸다. 비싼 것은 락이 아니라 경합이다.
- "테스트를 만 번 돌려 통과했으니 race가 없다" → 실행된 interleaving만 검증됐다. TSan조차 실행된 경로에 의존한다.
- "싱글 스레드 이벤트 루프라 동시성 버그가 없다" → data race는 없지만 await 경계에서 상태가 바뀌는 race condition은 남는다.
- "data race가 있어도 값이 조금 틀릴 뿐이다" → C/C++에서는 미정의 동작이고, 찢어진 읽기와 재정렬로 임의의 동작이 허용된다.
- "sleep으로 타이밍을 맞추면 고쳐진다" → race window를 줄일 뿐 제거하지 못하며, 환경이 바뀌면 되돌아온다.

## 7. 작성 순서와 검증 계획

1. 독자는 `00 → 01 → 02` 순서로 읽는다. interleaving·race 모델(01)이 동기화 계약·비용(02)의 전제다.
2. 모든 관찰 예제는 직접 실행해 확인한 수치를 기재하고 실행 환경(OS, CPU, clang·Node 버전)을 명시한다. macOS에서 실행 가능한 항목과 Linux가 필요한 항목(futex 관찰 등)을 구분한다.
3. 언어 중립을 유지한다 — 공통 계약(DRF-SC, happens-before)을 중심에 두고 언어별 차이는 표로 정리하며, 특정 언어 명세를 인용할 때 판본을 명시한다.
4. 확인 문제는 진단·판단형으로 만든다 — 주어진 interleaving에서 가능한 결과 열거, 코드에서 data race와 race condition 구분, 워크로드 조건에서 프리미티브 선택.
5. `docs/ch-8a/`는 navigation.ts의 `PHASE_LABELS`에 `'8a'` 레이블이 이미 등록되어 있으므로, 첫 문서 작성 시 빌드로 nav·sidebar에서 챕터 8과 9 사이 노출을 확인한다(저장소 운영 지침 적용).
6. ch-7 02와 ch-8 01의 위임 문장을 상대 링크로 회수하는 시점은 본문 집필 시다. 문서 수·완료 상태가 실제로 바뀔 때만 `PROGRESS.md`를 갱신하고, 실습(`exercises/ch-8a/`)은 본문 완료 후 §5 기획을 기준으로 작성한다.
