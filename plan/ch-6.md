# 챕터 6 기획 — 런타임과 메모리

[ROADMAP.md](../ROADMAP.md)의 챕터 6(`docs/ch-6/`, 문서 3편)을 집필하기 위한 상세 기획이다.
범위·경로가 ROADMAP과 어긋나면 ROADMAP을 우선한다.

## 1. 챕터의 관점

독자는 5년차 이상 개발자다. GC가 있는 언어(JS·Java·Python·Go)나 수동 관리 언어(C·C++·Rust)로 코드를 짜 왔고, 스택 트레이스를 읽고 메모리 프로파일러를 열어 본 경험은 있다. 그러나 그 출력이 어떤 구조 위에서 만들어지는지, 힙 지표가 오를 때 할당자·GC·커널 중 어느 층의 문제인지 구분하지 못할 수 있다.
이 챕터가 그 위에 더하는 것은 세 가지다.

1. **스택 트레이스와 크래시를 구조로 해석하기** — 호출 규약과 스택 프레임 모델을 세워 크래시 덤프, 스택 오버플로, 끊기는 async 스택 트레이스를 표면 증상이 아니라 구조로 설명한다.
2. **할당 비용의 실체** — `malloc`/`new`가 공짜가 아닌 이유를 할당자 내부(free list, size class, arena)와 단편화로 설명하고, 수동 관리·소유권(RAII·borrow checker)이 각각 무엇을 컴파일 타임과 런타임에 지불하는지 비교한다.
3. **GC를 트레이드오프로 판단하기** — 추적·참조 계수·세대별·동시 GC의 비용 구조를 지연 시간과 처리량 축 위에 놓고, 힙 설정과 할당 패턴이 일시정지에 미치는 영향을 실측으로 확인한다.

세 문서 모두 콘텐츠 집필 지침의 세 층위(동작 모델 → 설계 배경 → 경계 조건)로 구성하고, "이 언어에서는 이렇게 하라"가 아니라 전략별 비용 구조에서 선택 기준을 끌어낸다.

## 2. 범위 결정

### 다루는 것

- 프로세스 주소 공간의 큰 그림(코드·데이터·힙·스택), 호출 규약(calling convention), 스택 프레임 구조, 재귀와 스택 오버플로
- 정적·동적 링킹과 로딩, 심볼 해석, 예외 처리와 스택 언와인딩(zero-cost exception 테이블 방식)
- 힙 할당자 내부: free list, size class·bin, splitting·coalescing, arena와 thread cache(jemalloc·tcmalloc 사례), 내부·외부 단편화
- 수동 관리의 오류 유형(use-after-free, double free, leak), RAII와 결정적 해제, Rust 소유권·차용 검사의 개념 모델
- GC: 도달성과 root set, 참조 계수 vs 추적, mark-sweep·mark-compact·copying, 세대 가설과 세대별 GC, write barrier, incremental·concurrent GC와 tri-color invariant, STW 일시정지
- 런타임 사례: V8(scavenger + 주 GC), CPython(참조 계수 + cycle detector), JVM·Go GC의 설계 방향(이름과 트레이드오프 수준)

### 위임하는 것 (문서에 위임 지점을 명시한다)

| 주제 | 위임 대상 | 챕터 6에서의 취급 |
|------|-----------|------------------|
| 그래프 도달성·탐색 알고리즘 | ch-1 `04-graph-theory-and-algorithms.md` | mark 단계가 그래프 탐색임을 링크로 연결하고 알고리즘 자체는 재설명하지 않는다 |
| 바이트코드 VM 구조, JIT | ch-5 `03-interpreters-and-jit.md` | native 호출 규약과 VM 프레임의 대응 관계만 연결 |
| 캐시·메모리 계층이 할당자·GC 설계에 미치는 영향 | ch-7 `02-memory-hierarchy.md` | bump allocation·copying GC의 지역성 이점을 **현상으로** 언급, 하드웨어 원인은 위임 |
| 가상 메모리, `brk`/`mmap`, 페이지 폴트, copy-on-write | ch-8 `02-virtual-memory.md` | 할당자가 커널에서 메모리를 받아오는 경계(RSS와 heap used가 다른 이유)까지만 |
| 소유권의 타입 이론적 기반(선형·아핀 타입) | ch-4 `02-type-systems.md` | 이름만 연결 |
| 메모리 안전 취약점의 공격 기법 | (커리큘럼 밖) | UAF·overflow가 왜 취약점이 되는지 원인 구조까지만 |

### 다루지 않기로 결정한 것

- **어셈블리 문법 교육은 하지 않는다.** x86-64 System V 호출 규약을 대표 예로 들되 레지스터·명령어 나열이 아니라 "인자·반환값·복원 책임이 어디에 있는가"라는 계약 관점으로 다룬다. ISA 일반론은 ch-7이 담당한다.
- **GC 튜닝 플래그 카탈로그는 만들지 않는다.** JVM·V8의 개별 플래그 나열 대신, 실습에서 소수의 대표 설정(힙 크기, 세대 크기)만 바꿔 원리를 확인한다.
- **C++ 스마트 포인터 API 사용법은 다루지 않는다.** `unique_ptr`/`shared_ptr`는 RAII와 참조 계수의 구현 사례로만 언급한다.
- **PLT/GOT·재배치의 바이너리 포맷 상세는 다루지 않는다.** 동적 링킹은 "심볼을 언제 누가 해석하는가"의 수준까지만.

## 3. 문서별 상세 기획

각 문서는 콘텐츠 집필 지침의 기본 구조(학습 목표 → 배경 → 핵심 개념 → 실무 관점 → 더 깊이 → 정리 → 확인 문제 → 참고 자료)를 따르고, 45~90분 분량으로 작성한다.

### `01-runtime-systems.md` — 함수 호출은 어떻게 실행되는가

챕터의 기준 좌표계(주소 공간, 스택)를 세우는 문서다. 여기서 세운 스택 프레임 모델을 02(스택 vs 힙 경계)와 03(root set 스캔)이 재사용한다.

- **핵심 질문**: 스택 트레이스와 크래시 덤프는 어떤 구조 위에서 만들어지고, 어디까지 믿을 수 있는가?
- **핵심 개념 뼈대**
  - 프로세스 주소 공간의 지도: 코드·데이터·힙·스택의 배치. 가상 메모리 메커니즘은 ch-8로 위임하고 여기서는 좌표계로만 사용
  - 호출 규약: 인자 전달(레지스터·스택), 반환값, caller-saved/callee-saved 복원 책임 — x86-64 System V를 대표 사례로, "규약은 ABI 계약"이라는 관점
  - 스택 프레임: return address, frame pointer, 지역 변수. 스택 트레이스가 frame pointer(또는 언와인드 테이블)를 따라가는 걸음이라는 것
  - 재귀와 스택 오버플로: 스택 크기 한계(런타임별 기본값), tail call의 유무
  - 링킹·로딩: 정적 vs 동적, 심볼 해석 시점, 라이브러리 버전 충돌의 정체
  - 예외와 스택 언와인딩: zero-cost exception(정상 경로 무비용, throw 시 테이블 탐색)과 그 트레이드오프, 언와인딩 중 정리(소멸자·finally) 실행
- **실무 연결**: 인라인화·최적화로 스택 트레이스에서 프레임이 사라지는 이유, async/await에서 스택 트레이스가 끊기는 구조적 이유(콜 스택은 동기 실행 구간의 기록), source map·심볼 파일이 복원하는 것
- **관찰 예제**: Node.js에서 재귀 깊이 한계를 실측하고 `--stack-size`로 변화를 확인한다. C 최소 예제를 컴파일해 디버거(lldb) backtrace로 프레임 구조를 관찰한다(보조).
- **경계 조건**: frame pointer 생략 최적화(`-fomit-frame-pointer`)가 프로파일링을 방해하는 사례, FFI 경계에서 규약이 어긋날 때 생기는 오류

### `02-memory-management.md` — 힙 할당자와 소유권

- **핵심 질문**: `malloc`은 내부에서 무엇을 하는가? 왜 총 여유 메모리가 충분한데도 할당이 실패하거나 느려지는가?
- **핵심 개념 뼈대**
  - 할당자의 문제 정의: 임의 크기·임의 순서의 할당과 해제를 빠르게, 낭비 없이 — 이 두 목표가 충돌하는 지점
  - free list와 배치 전략(first-fit·best-fit), splitting과 coalescing, size class·bin 설계(dlmalloc 계보)
  - 멀티스레드와 arena·thread cache: jemalloc·tcmalloc이 전역 락을 피하는 구조
  - 내부·외부 단편화: 정의, 발생 조건(수명이 다른 객체가 섞이는 패턴), 측정의 어려움
  - 할당자와 커널의 경계: `brk`/`mmap`으로 받아온 메모리를 잘게 나눠 쓰는 구조, free가 OS 반환을 뜻하지 않는 이유(RSS vs heap used) — 상세는 ch-8
  - 수동 관리의 오류 유형: UAF, double free, leak — 각각이 할당자 자료구조를 어떻게 오염시키는가
  - 소유권 모델: RAII(스코프 = 수명), Rust 소유권·차용(컴파일 타임에 해제 시점 결정) — 런타임 비용 0의 대가로 표현력 제약을 지불한다는 트레이드오프
- **관찰 예제**: 크기가 다른 객체를 교차 할당·해제하는 시뮬레이션으로 free list 상태와 외부 단편화를 시각화한다. Node.js에서 대량 할당 후 해제해도 RSS가 즉시 줄지 않는 것을 관찰한다.
- **경계 조건**: 장수명 객체가 힙 곳곳에 박혀 coalescing을 막는 패턴, 할당자 교체(jemalloc 등)가 성능을 바꾸는 조건, "스택은 빠르고 힙은 느리다"가 성립하는 조건과 무너지는 조건(bump allocation)

### `03-garbage-collection.md` — 자동 메모리 관리의 비용 구조

- **핵심 질문**: GC 일시정지는 왜 생기고, 각 GC 설계는 지연 시간과 처리량 중 무엇을 사고 무엇을 파는가?
- **핵심 개념 뼈대**
  - 도달성: root set(스택·레지스터·전역)에서의 그래프 탐색이 "살아 있음"의 정의 — ch-1 그래프 탐색과 01의 스택 프레임을 재사용
  - 참조 계수: 즉시 회수와 캐시 지역성, 순환 참조 문제, 카운트 갱신 비용. CPython(참조 계수 + cycle detector), Swift ARC 사례
  - 추적 GC의 세 형태: mark-sweep(단편화 남음), mark-compact(이동 비용), copying(semispace — 공간 절반과 빠른 할당의 교환)
  - 세대 가설과 세대별 GC: minor/major 분리, write barrier와 remembered set이 지불하는 상시 비용
  - STW에서 동시 실행으로: incremental·concurrent GC, tri-color invariant와 배리어가 지키는 것, 부동 쓰레기(floating garbage)
  - 트레이드오프 지도: 처리량 vs 일시정지 vs 메모리 오버헤드(heap headroom) — V8(scavenger + 병렬·동시 주 GC), Go(저지연 동시 GC), JVM(G1·ZGC의 설계 방향)을 이 지도 위에 배치
- **실무 연결**: GC 언어에서도 leak이 생기는 구조(도달 가능하지만 불필요한 참조 — 클로저·캐시·전역), 힙 스냅샷으로 leak을 찾는 절차, 지연에 민감한 서비스에서 힙 크기와 일시정지의 관계
- **관찰 예제**: `node --trace-gc`로 scavenge와 mark-sweep 로그를 구분해 읽고, 단수명 객체 대량 생성 vs 장수명 객체 유지 워크로드에서 GC 빈도·일시정지가 달라지는 것을 확인한다.
- **경계 조건**: 세대 가설이 깨지는 워크로드(중간 수명 객체 대량 — 캐시·버퍼), finalizer·WeakRef의 함정(실행 시점 비보장), 참조 계수의 해제 연쇄(cascade)가 만드는 일시정지

## 4. 문서 간 의존 관계

```text
01 스택 프레임·주소 공간 ──▶ 02 스택 vs 힙의 경계 ──▶ 03 root set(스택 스캔)
                                    │
                                    └──▶ 03 sweep이 돌려준 메모리를 free list가 재사용
```

- 01의 주소 공간 지도와 스택 프레임 모델은 02(힙의 위치, 스택 할당과의 대비)와 03(root set 스캔)의 전제다.
- 02의 할당자 구조는 03에서 "sweep 후 메모리가 어디로 가는가", "copying GC가 단편화 문제를 구조적으로 없애는 이유"의 배경이 된다.
- ch-5 실습의 바이트코드 VM은 이 챕터 실습에서 GC를 얹는 숙주가 될 수 있으나, 실습은 ch-5 완료에 의존하지 않도록 독립 toy heap으로 설계한다(§5).
- 챕터 밖 연결은 §2의 위임 표를 따른다. 아직 집필되지 않은 챕터는 링크 대신 "챕터 N에서 다룬다"는 문장으로 위임한다.

## 5. 실습 과제 기획 (`exercises/ch-6/`)

ROADMAP 산출물: "mark-sweep GC를 직접 구현하고, 실제 언어 런타임의 힙을 프로파일링해 GC 정책이 지연 시간에 미치는 영향을 리포트로 정리한다."

### Part A — mark-sweep GC 구현

- **환경**: TypeScript + Node.js 24, `exercises/ch-6/` 아래 pnpm 워크스페이스 패키지. 외부 런타임 의존성 없음.
- **toy heap 설계**: `ArrayBuffer` 위에 고정 워드 단위 힙을 만든다. 객체는 헤더(크기, mark bit) + 참조 슬롯 배열로 제한해 태그·타입 시스템의 복잡도를 배제한다. root set은 명시적인 root 배열(가상의 스택·전역)로 표현한다.
- **구현 대상**
  1. bump 또는 free list 기반 `allocate` — 공간 부족 시 `collect` 트리거
  2. mark — root에서 참조 슬롯을 따라가는 명시적 스택 기반 탐색(재귀 금지, ch-1 04 연결)
  3. sweep — 힙 전체 순회로 미마크 객체를 free list에 반환
  4. (선택 확장) mark-compact 또는 2-공간 copying을 추가해 단편화·지역성 차이 비교
- **계측 인터페이스**: 각 collect마다 mark 시간, sweep 시간, 살아남은 객체 수·바이트, 회수 바이트, free list 조각 수(외부 단편화 지표)를 기록한다.
- **검증 시나리오**: 도달 불가 객체 회수, 순환 참조 회수(참조 계수와의 차이 입증), root에서 도달 가능한 객체 보존, 힙 가득 참 → collect → 재할당 성공. 전부 `node:test` 단위 테스트로 작성한다.

### Part B — 실제 런타임 힙 프로파일링 (V8/Node.js)

- **워크로드**: 요청을 처리하며 응답 지연을 히스토그램으로 기록하는 가짜 서버(순수 인메모리, 네트워크 배제). 할당 패턴을 두 축으로 조절한다 — 단수명 객체 비율, 장수명 유지 집합 크기.
- **측정 시나리오**
  1. `--trace-gc`로 scavenge/mark-sweep 빈도와 일시정지 분포를 워크로드별로 비교 — 세대 가설 확인
  2. 힙 설정(`--max-old-space-size`, `--max-semi-space-size`)을 바꿔가며 일시정지(p50/p99)와 처리량의 트레이드오프 곡선 기록
  3. 의도적 leak(전역 캐시에 누적)을 심고 힙 스냅샷 2장 비교로 leak 경로를 찾는 절차 수행
- **완료 기준 초안**: Part A 단위 테스트 전부 통과, 한 명령으로 재현되는 벤치·프로파일 스크립트, 리포트에 "할당 패턴·힙 설정이 일시정지에 미친 영향"과 "toy GC 계측과 V8 로그에서 공통으로 확인된 원리" 서술 포함. 상세 기준은 실습 문서 작성 시 확정한다.
- **미결**: 지연 히스토그램 기록 방식(직접 구현 vs `perf_hooks` 활용), Part A의 힙 워드 크기·객체 표현 상세는 실습 문서 작성 시점에 결정한다.

## 6. 조사 노트 — 1차 자료 후보

집필 시 아래를 우선 확인하고, 런타임 버전에 의존하는 동작(V8 GC 구조, 기본 힙 크기)은 인용 시점에 재검증한다.

- **호출 규약·ABI**: System V AMD64 ABI 명세, Itanium C++ ABI(예외 처리·언와인딩), Ulrich Drepper "How To Write Shared Libraries"(동적 링킹)
- **할당자**: Doug Lea "A Memory Allocator"(dlmalloc 설계 문서), jemalloc 논문(Jason Evans, 2006)과 공식 문서, tcmalloc 설계 문서, Wilson et al. "Dynamic Storage Allocation: A Survey and Critical Review"(단편화·배치 전략의 표준 서베이)
- **소유권**: The Rust Programming Language(공식 북) ownership 장, Rust Reference의 destructor 규정
- **GC 일반**: Jones, Hosking, Moss *The Garbage Collection Handbook* 2판(전 영역의 표준 참조), Ungar의 세대 가설 논문(1984), Cheney copying 알고리즘(1970), Dijkstra et al. on-the-fly GC(1978, tri-color)
- **런타임별**: v8.dev "Trash talk: the Orinoco garbage collector" 및 관련 블로그, Go 공식 "A Guide to the Go Garbage Collector", CPython 공식 문서의 `gc` 모듈·개발자 가이드(참조 계수 + cycle detector), OpenJDK G1·ZGC 공식 문서
- **관찰 도구**: Node.js 공식 문서(`--trace-gc`, heap snapshot, `perf_hooks`), Chrome DevTools 메모리 프로파일링 문서

### 통념 검증 목록 (본문에서 정면으로 다룰 것)

- "GC 언어에서는 메모리 leak이 없다" → 도달 가능하지만 불필요한 참조는 GC가 회수할 수 없다. leak의 정의가 달라질 뿐이다.
- "free/해제하면 메모리가 OS로 반환된다" → 할당자가 재사용을 위해 보유한다. RSS와 heap used의 간극으로 확인한다.
- "참조 계수는 추적 GC보다 항상 일시정지가 짧다" → 대형 구조 해제의 연쇄(cascade)가 임의 길이의 정지를 만든다.
- "스택 할당은 빠르고 힙 할당은 느리다" → bump allocation 힙(V8 new space)은 스택과 유사한 비용이다. 느린 것은 할당이 아니라 회수·추적의 총비용이다.
- "GC 일시정지는 힙 크기에 비례한다" → mark 비용은 살아 있는 객체 수에, sweep은 힙 크기에, 동시 GC의 STW는 그보다 훨씬 작은 root 스캔에 의존한다. 어떤 GC인지에 따라 다르다.
- "예외는 느리므로 쓰면 안 된다" → zero-cost 방식은 정상 경로 비용이 0에 가깝고 throw 경로가 비싸다. 비용 위치를 구분해야 판단할 수 있다.

## 7. 작성 순서와 검증 계획

1. `01 → 02 → 03` 순서로 집필한다. 주소 공간·스택 모델(01)이 힙 논의(02)의 좌표계이고, 할당자(02)가 GC(03)의 전제이기 때문이다.
2. 모든 실행 예제는 Node.js 24에서 직접 실행해 관찰 결과를 확인한 뒤 수치를 기재하고, 실행 환경(OS·Node 버전·CPU)을 문서에 명시한다. C 보조 예제(스택 프레임 관찰)는 macOS clang 기준으로 작성하되 플랫폼 의존을 명시한다.
3. GC 동작 서술은 The GC Handbook의 용어를 기준으로 삼고, V8·Go·CPython의 현재 구현과 다른 지점은 "일반 모델 vs 특정 구현"으로 구분해 서술한다.
4. `docs/ch-6/`을 처음 만들 때 `docs/.vitepress/navigation.ts`의 `PHASE_LABELS`에 챕터 6 레이블을 등록하고 빌드로 nav·sidebar 노출을 확인한다(저장소 운영 지침 적용).
5. 문서 수나 완료 상태가 실제로 바뀔 때만 `PROGRESS.md`를 갱신한다. 실습 문서(`exercises/ch-6/`)는 docs 3편 완료 후 §5 기획을 기준으로 작성한다.
