# 6.2 메모리 관리 — 힙 할당자와 소유권

`malloc`과 `new`는 문법이 아니라 알고리즘의 호출이다 — 임의 크기·임의 순서의 할당과 해제를 빠르게, 낭비 없이 처리하려는 자료구조가 그 아래에서 돈다. 이 문서는 할당자 내부(free list, size class, arena)와 단편화를 세워 "여유 메모리가 충분한데 왜 실패하는가"와 "free했는데 왜 RSS가 안 줄어드는가"를 구조로 설명하고, 해제 시점의 결정을 런타임에서 컴파일 타임으로 옮기는 소유권 모델의 트레이드오프를 다룬다. [6.1](./01-runtime-systems.md)의 주소 공간 지도와 스택 프레임 모델을 전제한다.

## 학습 목표

- 힙 할당자가 푸는 문제(임의 수명 객체의 배치)를 정의하고, 속도와 메모리 낭비가 충돌하는 지점을 설명한다.
- free list·splitting·coalescing·size class로 범용 할당자의 구조를 설명하고, 내부·외부 단편화를 구분해 진단한다.
- RSS와 heap used가 다른 이유를 할당자와 커널의 경계로 설명하고, 실측으로 확인한다.
- use-after-free·double free·leak이 각각 할당자 자료구조를 어떻게 오염시키는지 설명한다.
- 수동 관리·RAII·Rust 소유권이 각각 컴파일 타임과 런타임에 무엇을 지불하는지 비교해 선택 기준을 세운다.

## 배경: 왜 이것이 존재하는가

[6.1](./01-runtime-systems.md)의 스택은 훌륭한 메모리 관리자다 — 할당은 스택 포인터 이동 한 번, 해제는 반환과 동시에 공짜, 단편화는 원리적으로 없다. 이 효율은 강한 전제에서 나온다: **수명이 스코프에 묶여 있고, 해제 순서가 할당의 역순**(LIFO)이라는 것.

문제는 프로그램의 많은 객체가 이 전제를 어긴다는 데 있다. 요청 A가 만든 객체를 요청 B가 참조하고, 콜백에 캡처된 값은 함수가 반환한 뒤에도 살아야 하며, 캐시 항목의 수명은 어떤 스코프와도 무관하다. 수명이 호출 구조를 벗어나는 순간 스택은 쓸 수 없고, **임의 시점에 할당되어 임의 시점에 죽는 객체들을 위한 별도 영역** — 힙 — 과 그것을 관리하는 알고리즘 — 할당자 — 이 필요해진다.

핵심 긴장은 처음부터 정해져 있다. 할당·해제는 프로그램에서 가장 잦은 연산에 속하므로 **빨라야 하고**(상수 시간에 가깝게), 반환된 메모리는 재사용해야 하므로 **낭비가 없어야 한다**(빈 공간을 잘 찾고 잘 합쳐야 한다). 그런데 잘 찾으려면 탐색이 필요하고 탐색은 느리다. 범용 할당자의 역사는 이 두 목표 사이의 절충의 역사이고, dlmalloc에서 jemalloc·tcmalloc으로 이어지는 계보가 그 절충을 어떻게 옮겨 왔는지가 이 문서의 뼈대다.

## 핵심 개념

관찰 예제의 실행 환경: Apple M5 Pro(arm64), macOS 26.5.2, Node.js 24.14.0(V8 13.6). 절대 수치는 환경에 따라 다르다.

### free list — 빈 블록의 장부

가장 단순한 할당자 모델에서 출발한다. 힙은 커널에서 받아온 큰 연속 영역이고, 할당자는 그중 빈 블록들을 연결 리스트 — **free list** — 로 관리한다.

- **할당**: free list를 훑어 요청 크기 이상의 블록을 찾는다. 처음 만나는 것을 쓰면 first-fit, 가장 딱 맞는 것을 고르면 best-fit이다. best-fit은 낭비가 적을 것 같지만 전체 탐색이 필요하고 "딱 맞고 남은" 자투리가 너무 작아 쓸모없어지는 경향이 있어, 어느 쪽도 일방적으로 이기지 못한다(Wilson et al.의 서베이가 이 비교의 표준 자료다).
- **splitting**: 찾은 블록이 요청보다 크면 쪼개서 앞부분을 내주고 나머지를 free list에 남긴다.
- **coalescing**: 해제된 블록이 앞뒤의 빈 블록과 인접하면 합쳐서 큰 블록으로 되돌린다. 이것이 없으면 힙은 시간이 갈수록 잘게 조각난 채로 고정된다.

각 블록은 자기 크기 등을 담은 **헤더**를 몸통 앞에 붙인다. `free(ptr)`가 크기 인자 없이 동작하는 이유이고, 몇 바이트짜리 객체라도 헤더+정렬만큼의 고정 오버헤드를 내는 이유이기도 하다.

### 관찰 1 — 외부 단편화를 시뮬레이션으로 본다

first-fit free list 할당자를 워드 단위 toy 힙으로 만들어, "총 여유는 충분한데 할당이 실패하는" 상황을 직접 만든다. 다음은 완전한 실행 예제다.

```js
// freelist-sim.mjs — first-fit free list 할당자의 외부 단편화 관찰
// 워드 단위 toy 힙: 할당은 [offset, size] 예약, 해제는 free list 반환 + 인접 블록 병합(coalescing)

class FreeListHeap {
  constructor(size) {
    this.size = size;
    this.free = [{ offset: 0, size }]; // offset 오름차순 유지
  }

  allocate(size) {
    // first-fit: 처음 만나는 충분한 블록을 쪼갠다(splitting)
    for (const block of this.free) {
      if (block.size < size) continue;
      const offset = block.offset;
      block.offset += size;
      block.size -= size;
      if (block.size === 0) this.free.splice(this.free.indexOf(block), 1);
      return { offset, size };
    }
    return null; // 외부 단편화: 총합은 충분해도 연속 블록이 없으면 실패
  }

  release({ offset, size }) {
    const i = this.free.findIndex((b) => b.offset > offset);
    const at = i === -1 ? this.free.length : i;
    this.free.splice(at, 0, { offset, size });
    // 앞뒤 블록과 인접하면 병합한다
    for (let j = this.free.length - 2; j >= 0; j--) {
      const [a, b] = [this.free[j], this.free[j + 1]];
      if (a.offset + a.size === b.offset) {
        a.size += b.size;
        this.free.splice(j + 1, 1);
      }
    }
  }

  stats() {
    const total = this.free.reduce((s, b) => s + b.size, 0);
    const largest = Math.max(0, ...this.free.map((b) => b.size));
    return `free ${total}/${this.size} words, ${this.free.length} fragments, largest hole ${largest}`;
  }
}

const heap = new FreeListHeap(256);

// 단수명(크기 6)과 장수명(크기 2) 객체를 교차 할당한다
const shortLived = [];
const longLived = [];
for (let i = 0; i < 32; i++) {
  shortLived.push(heap.allocate(6));
  longLived.push(heap.allocate(2));
}
console.log('interleaved :', heap.stats());

// 단수명만 전부 해제 — 장수명 객체가 병합을 가로막는다
for (const obj of shortLived) heap.release(obj);
console.log('freed short :', heap.stats());

// 총 여유는 192워드지만 연속 8워드가 없어 실패한다
console.log('allocate(8) :', heap.allocate(8));
```

이 환경의 출력이다(결정적이므로 어디서 실행해도 같다).

```text
interleaved : free 0/256 words, 0 fragments, largest hole 0
freed short : free 192/256 words, 32 fragments, largest hole 6
allocate(8) : null
```

힙의 75%(192워드)가 비어 있는데 8워드 할당이 실패한다. 크기 2짜리 장수명 객체 32개가 8워드 간격으로 박혀서 coalescing이 만들 수 있는 최대 구멍이 6워드이기 때문이다. 이것이 **외부 단편화** — 여유 공간이 쓸 수 없는 모양으로 존재하는 상태 — 이고, 발생 조건도 이 시뮬레이션에 그대로 있다: **수명이 다른 객체가 주소 공간에서 섞이는 할당 패턴**. 실제 서비스에서 "장기 캐시 항목과 요청 단위 버퍼를 같은 힙에 교차 할당"하는 코드가 정확히 이 패턴이다.

### size class와 bin — 탐색을 없애는 분리수납

free list 탐색을 매번 하는 것은 느리다. 현대 할당자의 공통 답은 **size class**다: 요청 크기를 미리 정한 등급(예: 16, 32, 48, …, 그 위로는 등비)으로 올림하고, 등급마다 전용 free list(**bin**)를 둔다. 할당은 "요청 → 등급 계산 → 해당 bin의 머리를 뽑기"로, 탐색 없이 상수 시간이 된다. dlmalloc이 이 구조를 대중화했고 jemalloc·tcmalloc도 기본 뼈대는 같다.

대가는 **내부 단편화**다 — 40바이트 요청이 48바이트 등급에 배정되면 8바이트는 블록 안에서 낭비된다. 외부 단편화와 대칭인 개념이다: 내부는 할당된 블록 **안**의 낭비(올림의 대가), 외부는 블록들 **사이**의 낭비(수명 혼합의 대가). 등급을 촘촘히 하면 내부 단편화가 줄지만 bin이 많아져 각 bin의 재사용률이 떨어진다 — 여기도 절충이다.

### arena와 thread cache — 전역 락을 피하는 구조

힙은 프로세스 전역 자원이므로, 멀티스레드에서 순진한 할당자는 모든 `malloc`·`free`가 하나의 락을 다투는 병목이 된다. jemalloc(Jason Evans, 2006)과 tcmalloc이 이 문제를 푼 구조가 현대 표준이 됐다.

- **arena**: 힙을 여러 독립 할당 영역으로 나누고 스레드들을 분산 배정한다. 서로 다른 arena의 할당은 경합하지 않는다.
- **thread cache**: 각 스레드가 작은 크기 등급의 블록 꾸러미를 락 없이 쓰는 전용 캐시로 보유한다(tcmalloc의 tc가 thread cache다). 대부분의 소형 할당·해제는 자기 캐시 안에서 끝나고, 캐시가 비거나 넘칠 때만 상위(중앙 free list, arena)로 간다.

구조의 핵심은 **경로의 계층화**다 — 빠른 경로(thread cache, 락 없음)가 대부분을 처리하고, 느린 경로(arena, 커널)로 갈수록 드물어진다. 대가도 명확하다: 스레드·arena마다 캐시로 잡아 둔 미사용 블록만큼 메모리 사용량이 늘고, 한 스레드가 할당한 것을 다른 스레드가 해제하는 패턴(생산자-소비자)은 빠른 경로를 벗어난다.

### 할당자와 커널의 경계 — free는 반환이 아니다

할당자 자신도 메모리를 커널에서 받아온다 — 데이터 세그먼트 끝을 미는 `brk`, 임의 위치에 페이지를 매핑하는 `mmap`(메커니즘은 [8.2](../ch-8/02-virtual-memory.md)). 중요한 것은 단위의 불일치다: 커널과의 거래는 페이지(수 KB) 단위의 비싼 시스템 콜이고, 프로그램의 요청은 수십 바이트 단위의 잦은 함수 호출이다. 할당자의 존재 이유가 바로 이 중개 — **크게 받아와서 잘게 나눠 쓰고, 해제되면 커널에 돌려주는 대신 재사용을 위해 보유한다**.

이 구조에서 "메모리 사용량"은 층마다 다른 숫자가 된다. 프로그램 관점의 사용량(heap used: 살아 있는 객체의 총합)과 커널 관점의 사용량(RSS: 프로세스에 매핑되어 물리 메모리에 올라온 페이지 총합) 사이에, 할당자가 재사용을 위해 보유 중인 페이지가 끼어 있다. `free`(또는 GC의 회수)는 첫 번째 숫자만 즉시 줄인다.

### 관찰 2 — heapUsed와 RSS의 간극 실측

Node.js에서 작은 객체 수백만 개를 할당했다 해제하고, V8이 보고하는 힙 사용량과 커널이 보고하는 RSS를 대조한다.

```js
// rss-vs-heap-small.mjs — node --expose-gc rss-vs-heap-small.mjs
const mb = (n) => (n / 1024 / 1024).toFixed(1).padStart(7) + ' MB';
const show = (label) => {
  const { heapUsed, heapTotal, rss } = process.memoryUsage();
  console.log(label.padEnd(12), 'heapUsed', mb(heapUsed), ' heapTotal', mb(heapTotal), ' rss', mb(rss));
};

show('start');

// 작은 객체 400만 개 — old space 페이지 곳곳에 흩어진다
let retained = [];
for (let i = 0; i < 4_000_000; i++) retained.push({ id: i, next: null });
// 열 개 중 하나만 남기고 해제 — 페이지마다 생존자가 박힌다
retained = retained.filter((o) => o.id % 10 === 0);
globalThis.gc();
show('sparse');

retained = null;
globalThis.gc();
show('all freed');

setTimeout(() => show('after 5s'), 5000);
```

이 환경의 출력이다.

```text
start        heapUsed     3.5 MB  heapTotal     5.6 MB  rss    44.2 MB
sparse       heapUsed    23.2 MB  heapTotal   289.1 MB  rss   240.6 MB
all freed    heapUsed     3.5 MB  heapTotal   133.1 MB  rss   236.2 MB
after 5s     heapUsed     3.5 MB  heapTotal   133.1 MB  rss   236.3 MB
```

두 줄이 각각 하나씩 증명한다. `sparse` 줄: 살아 있는 객체는 23.2MB인데 V8이 커널에서 받아 둔 힙(heapTotal)은 289MB — 10%의 생존자가 페이지 곳곳에 박혀 있으면 페이지를 돌려줄 수 없다(관찰 1의 외부 단편화가 페이지 규모에서 재현된 것이다). `all freed`·`after 5s` 줄: 참조를 전부 끊고 full GC를 두 번 지나도 RSS는 236MB에 머문다 — **해제는 할당자 장부의 갱신이지 커널 반환이 아니다**. 대시보드의 RSS 그래프가 트래픽이 빠진 뒤에도 내려오지 않는 것은 (heap used가 함께 높지 않은 한) leak의 증거가 아니라 이 보유 정책의 관찰이다.

경계 조건 하나: 같은 실험을 큰 배열(수백 KB 이상) 200개로 하면 RSS가 크게 내려온다(이 환경 실측: 210.6MB → 58.6MB). V8이 큰 객체를 별도 영역(large object space)에 페이지 단위로 매핑해, 해제 시 그대로 unmap할 수 있기 때문이다. "돌려주는가"는 원리의 문제가 아니라 **객체 크기·영역·할당자 정책의 함수**다 — glibc malloc도 큰 할당은 `mmap`으로 받아 `free` 때 즉시 반환한다.

### 수동 관리의 오류 유형 — 장부의 오염

C·C++처럼 해제를 프로그래머가 호출하는 세계의 오류 세 가지는, 할당자 자료구조(장부)와 대조하면 구조가 선명해진다.

- **use-after-free(UAF)**: 해제된 블록은 free list로 돌아가 재할당될 수 있다. 옛 포인터로 읽으면 남의 데이터가 보이고, 쓰면 **남의 객체나 할당자 헤더를 오염**시킨다. 증상이 원인에서 멀리 떨어져 나타나는 이유(6.1의 FFI 크래시와 같은 구조)이자, 공격자가 재할당 내용을 통제하면 취약점이 되는 이유다. 공격 기법 자체는 이 커리큘럼 범위 밖이다.
- **double free**: 같은 블록이 free list에 두 번 들어가면, 이후 두 번의 할당이 같은 메모리를 서로 소유한다 — 이후의 모든 오류는 UAF와 같은 구조로 전개된다.
- **leak**: 해제를 잊으면 블록은 영원히 "사용 중"이다. 장부는 멀쩡하다는 점이 앞의 둘과 다르다 — 오염이 아니라 누적이며, 그래서 크래시 대신 우상향 그래프로 나타난다.

현대 할당자가 헤더에 무결성 검사를 넣고(`free(): invalid pointer`류의 abort가 그것), AddressSanitizer 같은 도구가 해제된 블록의 재사용을 지연시키며 감시하는 것은 전부 이 오염을 조기에 드러내려는 장치다.

### 소유권 — 해제 시점의 결정을 컴파일 타임으로

세 오류의 공통 원인은 "이 객체를 언제 해제해도 되는가"라는 판단이 프로그래머의 머릿속에만 있다는 것이다. 이 판단을 옮기는 두 전략이 있다 — 런타임으로 옮기면 [6.3](./03-garbage-collection.md)의 GC이고, **컴파일 타임으로 옮기면 소유권 모델**이다.

- **RAII**(C++): 자원의 수명을 객체의 스코프에 묶는다 — 생성자가 획득하고 소멸자가 해제하며, 소멸자 호출은 컴파일러가 스코프 탈출 지점(정상·예외 모두, [6.1의 언와인딩](./01-runtime-systems.md)이 보장)에 삽입한다. 해제 시점이 코드 구조에서 결정되므로 **결정적**(deterministic)이다 — 파일 핸들·락처럼 "언젠가"가 아니라 "지금" 닫혀야 하는 자원에 GC보다 적합한 이유. C++ `unique_ptr`은 이 패턴의 표준 구현이고, `shared_ptr`는 참조 계수(6.3에서 비용을 다룬다)를 얹은 변형이다. 한계는 컴파일러가 검사하지 않는 뒷문이다 — 원시 포인터로 별칭을 만들면 UAF는 여전히 가능하다.
- **Rust 소유권·차용**: 모든 값에 소유자가 정확히 하나이고, 소유자가 스코프를 벗어나면 해제된다(RAII와 같다). 다른 점은 **별칭까지 타입 시스템이 추적**한다는 것 — 참조(차용)는 "가변 참조 하나 또는 불변 참조 여럿"이라는 규칙 아래 수명이 검사되고, 해제된 뒤에도 살아 있는 참조는 컴파일 오류다. UAF·double free·데이터 레이스가 컴파일 타임에 배제되고 런타임 비용은 0이다.

공짜가 아니다 — 지불하는 것은 **표현력과 컴파일 타임의 증명 부담**이다. 소유자가 하나로 정해지지 않는 구조(순환 참조하는 그래프, 여러 곳에서 수정하는 공유 상태)는 차용 검사기가 안전을 증명할 수 없으므로, 설계를 바꾸거나(인덱스 기반 그래프), 런타임 검사로 후퇴하거나(`Rc<RefCell<T>>` — 참조 계수 + 실행 시점 차용 검사), `unsafe`로 증명 책임을 프로그래머가 되가져와야 한다. "GC의 런타임 비용 vs 소유권의 컴파일 타임 비용"이라는 축은 6.3의 트레이드오프 지도에서 완성된다. 자원 사용을 타입으로 제한하는 이 접근의 이론적 이름(선형·아핀 타입)은 [4.2의 타입 시스템 확장 논의](../ch-4/02-type-safety-and-inference.md)와 연결된다.

## 실무 관점

### "스택은 빠르고 힙은 느리다"가 성립하는 조건

이 통념은 힙 할당 = free list 탐색 + 헤더 관리 + (경합 시) 락이라는 모델에서는 참이다. 그러나 **bump allocation** — 영역의 끝 포인터를 증가시키기만 하는 할당 — 을 쓰는 힙에서는 무너진다. V8의 new space(6.3), arena 할당자, 요청 단위로 통째로 버리는 region 할당자가 그렇다 — 할당 비용은 스택과 같은 "포인터 이동 한 번"이다. 이들이 싼 이유는 **해제를 개별로 하지 않기 때문**이다: 살아남은 것만 옮기고 영역째 버리거나(copying GC), 수명이 같은 객체를 묶어 통째로 해제한다(arena). 즉 정확한 명제는 "힙 할당이 느리다"가 아니라 "**임의 순서의 개별 해제를 지원하는 것이 비싸다**"이고, 비용의 실체는 할당이 아니라 회수·재사용 관리다. 이 재정식화가 6.3에서 GC 비용 구조를 읽는 열쇠가 된다.

### 장수명 객체가 힙을 못박는 패턴

관찰 1·2가 같은 패턴을 두 규모에서 보였다: 드문드문 살아남은 장수명 객체가 coalescing(블록 규모)과 페이지 반환(커널 규모)을 가로막는다. 실무 신호는 "트래픽 대비 메모리가 계단식으로만 오르고 내려오지 않는" 그래프다. 완화책도 원인 구조에서 나온다 — 수명이 뚜렷이 다른 할당을 섞지 않기(장기 캐시는 시작 시 한 번에 확보, 요청 단위 버퍼는 풀링), 크기가 같은 객체는 풀로 묶기, 그리고 이동이 가능한 관리 런타임이라면 compaction(6.3)이 이 문제를 구조적으로 없앤다는 것.

### 할당자 교체가 성능을 바꾸는 조건

"jemalloc으로 바꿨더니 빨라졌다/메모리가 줄었다"는 보고는 흔하지만 마법이 아니다 — 기본 할당자와 대체 할당자가 다른 절충을 골랐고, 워크로드가 그 차이를 밟았을 때만 효과가 난다. 교체를 검토할 신호: 멀티스레드 할당 경합(프로파일에서 `malloc` 내부 락 대기가 보임), 장수명 프로세스의 RSS가 heap used 대비 지속적으로 크게 유지됨(보유·반환 정책 차이), 특정 크기 패턴에서의 단편화. 반대로 할당이 병목이 아닌 서비스에서는 아무 일도 일어나지 않는다. 검증 방법은 단순하다 — `LD_PRELOAD`(Linux)로 교체는 코드 수정 없이 가능하므로, 실제 워크로드에서 RSS·지연 분포를 전후 비교한다. 주장이 아니라 측정이 결론을 내야 한다.

## 더 깊이

### 단편화는 왜 측정이 어려운가

"단편화율 몇 %"라는 단일 숫자는 대부분 정의가 불분명하다. 내부 단편화는 할당자가 등급 통계를 내면 계산할 수 있지만, 외부 단편화는 **미래의 할당 요청에 따라 같은 힙 상태가 문제일 수도 아닐 수도 있다** — 관찰 1의 힙은 6워드 요청에게는 전혀 단편화되어 있지 않다. 그래서 실무 지표는 대용(proxy)들이다: `heapTotal - heapUsed`(또는 jemalloc의 `stats.active` 대 `stats.resident`)의 지속적 간극, 같은 워크로드에서 시간이 지날수록 커지는 RSS/heap used 비율, 그리고 할당 실패나 성능 저하라는 결과 자체. toy 할당자로 "free list 조각 수"와 "최대 구멍 크기"를 직접 세어 보는 것(챕터 실습 `exercises/ch-6/`)이 이 지표들의 의미를 몸에 붙이는 가장 빠른 길이다.

### 힙 메타데이터는 어디에 사는가

블록 헤더를 블록 바로 앞에 두는 고전 설계(dlmalloc)는 지역성이 좋지만, 힙 버퍼 오버플로가 곧바로 할당자 메타데이터를 덮는다는 보안 약점이 있다. jemalloc·tcmalloc이 메타데이터를 별도 영역에 두는(out-of-band) 쪽으로 옮겨 온 이유 중 하나다. 같은 결정이 캐시 동작도 바꾼다 — 헤더가 인라인이면 `free`가 헤더를 읽을 때 그 캐시 라인을 끌어오고, 별도면 다른 라인을 건드린다. 메모리 계층에서의 함의는 [7.2](../ch-7/02-memory-hierarchy.md)의 모델로 읽어라.

## 정리

- 힙 할당자는 "임의 수명 객체의 배치"라는 문제를 free list·splitting·coalescing으로 풀고, size class로 탐색을 없애며, arena·thread cache로 락을 피한다 — 각 장치는 속도와 낭비 사이의 절충이다.
- 외부 단편화의 원인은 수명이 다른 객체의 혼합이다. 총 여유의 크기가 아니라 **연속 블록의 존재**가 할당 성공을 결정한다(시뮬레이션으로 확인).
- free는 커널 반환이 아니라 장부 갱신이다. heapUsed 3.5MB에 RSS 236MB가 공존하는 것을 실측했다 — RSS 그래프 단독으로 leak을 판정하지 마라.
- UAF·double free는 할당자 장부를 오염시켜 증상을 원인에서 분리시키고, leak은 장부가 멀쩡한 채 누적된다 — 진단 도구가 다른 이유다.
- RAII·Rust 소유권은 해제 시점 결정을 컴파일 타임으로 옮겨 런타임 비용 0을 얻고, 표현력 제약(단일 소유자로 증명 가능한 구조만)을 지불한다.
- 느린 것은 힙 할당 자체가 아니라 임의 순서의 개별 해제 지원이다. bump allocation은 스택급으로 싸다 — 이 재정식화를 6.3에 가져간다.

## 확인 문제

**1.** 장수명 Node.js 서비스에서 heapUsed는 안정적인데 RSS만 배포 주기 내내 완만히 상승한다. 운영팀은 "leak이므로 주기적 재시작"을 제안한다. 이 문서의 모델로 (a) leak이 아닐 가능성이 높은 근거, (b) 그래도 확인해야 할 것, (c) 재시작보다 나은 대응 후보를 제시하라.

::: details 정답과 해설
(a) leak은 도달 가능한 객체의 누적이므로 heapUsed(살아 있는 객체 총합)에 나타난다. heapUsed가 평평하다면 상승분은 할당자·V8이 재사용을 위해 보유한 페이지, 즉 heapTotal/RSS와 heapUsed의 간극이다(관찰 2에서 실측한 구조). (b) 외부 단편화의 진행 — 같은 워크로드에서 RSS/heapUsed 비율이 시간에 따라 계속 커지는지, 그리고 네이티브 애드온 등 V8 힙 밖(external, ArrayBuffer) 메모리가 자라는지(process.memoryUsage의 external 항목). (c) 수명이 다른 할당의 혼합을 줄이는 코드 수정(캐시 사전 확보, 버퍼 풀링), 컨테이너 제한 대비 여유 확인. 비율이 안정화되어 있다면 정상 보유이므로 대응 자체가 불필요하다.
:::

**2.** 관찰 1의 시뮬레이션에서 힙의 75%가 비어 있는데 8워드 할당이 실패했다. (a) 같은 힙 상태에서 실패 없이 계속 서비스할 수 있는 요청 패턴은 무엇인가? (b) copying/compacting GC가 있는 런타임에서는 이 실패가 왜 구조적으로 발생하지 않는가?

::: details 정답과 해설
(a) 6워드 이하의 할당만 오는 패턴 — 최대 구멍이 6워드이므로 6 이하 요청은 전부 성공한다. 외부 단편화가 절대 상태가 아니라 "힙 상태 × 미래 요청 크기"의 함수라는 것이 요점이다. (b) 이동 가능한 GC는 살아 있는 객체를 한쪽으로 몰아 복사·압축하므로(6.3), 빈 공간이 항상 하나의 연속 영역으로 정리된다 — 구멍의 모양이라는 문제 자체가 사라지고, 그 대가로 객체 이동 비용과 포인터 갱신(따라서 정확한 참조 추적)을 지불한다. C/C++ 할당자가 이 방법을 못 쓰는 이유는 원시 포인터의 주소를 바꿀 수 없기 때문이다.
:::

**3.** 팀이 성능을 이유로 서비스의 일부를 Rust로 재작성하는 안과 현행 GC 언어 + 객체 풀링으로 최적화하는 안을 비교하고 있다. 이 문서의 "해제 시점 결정을 누가 하는가" 축으로 두 안이 지불하는 비용을 각각 설명하라.

::: details 정답과 해설
Rust 안: 해제 시점 결정이 컴파일 타임으로 옮겨져 런타임 비용(GC 일시정지, 카운트 갱신)이 0이 되지만, 컴파일 타임의 증명 부담을 지불한다 — 공유·순환이 많은 도메인 모델은 설계 변경(단일 소유자 구조, 인덱스 참조)이나 `Rc<RefCell>`·`unsafe` 후퇴가 필요하고, 이는 재작성 비용과 팀 학습 비용으로 나타난다. 풀링 안: GC 언어 안에서 객체 수명을 수동 관리로 되돌리는 것이므로, 할당·회수 비용은 줄지만 수동 관리의 오류 유형이 되돌아온다 — 풀에 반환한 객체를 계속 참조하면 GC 언어인데도 UAF와 동형인 버그(살아 있는 두 소유자)가 생기고, 반환을 잊으면 풀이 leak이 된다. 어느 쪽도 공짜가 아니며, 선택 기준은 병목이 실제로 회수 비용인지(프로파일), 그리고 어느 비용(증명 부담 vs 수동 관리 위험)을 팀이 지속 가능하게 지불할 수 있는지다.
:::

## 참고 자료

- Doug Lea, [A Memory Allocator](https://gee.cs.oswego.edu/dl/html/malloc.html) — dlmalloc 설계 문서. free list·bin·coalescing 설계 판단의 1차 자료이며 본문 모델의 원형이다.
- Paul R. Wilson et al., [Dynamic Storage Allocation: A Survey and Critical Review](https://citeseerx.ist.psu.edu/document?doi=10.1.1.47.275) (1995) — 배치 전략과 단편화 연구의 표준 서베이. first-fit/best-fit 비교와 "단편화는 수명 혼합의 함수"라는 본문 주장의 근거다.
- Jason Evans, [A Scalable Concurrent malloc(3) Implementation for FreeBSD](https://www.bsdcan.org/2006/papers/jemalloc.pdf) (2006) — jemalloc 논문. arena 설계의 동기와 측정을 담고 있다.
- [tcmalloc design 문서](https://google.github.io/tcmalloc/design.html) — thread cache·size class 계층 구조의 현행 공식 설명.
- [The Rust Programming Language — Understanding Ownership](https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html) — 소유권·차용 규칙의 공식 서술. 본문이 개념 모델만 다룬 차용 검사의 실제 규칙을 확인할 수 있다.
- [Node.js 문서 — process.memoryUsage()](https://nodejs.org/api/process.html#processmemoryusage) — 관찰 2에서 쓴 rss·heapTotal·heapUsed·external 각 항목이 세는 것의 정의.
