# 8a.1 race condition과 interleaving — 실행은 하나가 아니다

`counter++` 한 줄은 원자적이지 않고, 검사를 통과한 조건은 행동하는 순간 이미 거짓일 수 있다. 이 문서는 interleaving 실행 모델로 "코드 하나가 정의하는 가능한 실행들의 집합"을 세우고, data race와 race condition을 구분한 뒤, 가끔만 실패하는 버그를 스트레스 증폭과 ThreadSanitizer로 재현·탐지하는 방법을 만든다. 관찰 예제는 macOS 26.5.2(Apple M5 Pro), Node.js v24.14.0, Apple clang 21에서 실행해 확인했다.

## 학습 목표

- interleaving 모델로 공유 상태 접근의 가능한 실행 결과를 열거하고 race window를 식별한다.
- 소스 코드의 한 줄과 실행의 원자적 단위가 다르다는 것을 실측으로 설명한다.
- data race(언어 계약 위반)와 race condition(논리 오류)을 구분하고, 각각의 결과가 왜 다른 종류의 위험인지 설명한다.
- 스트레스 증폭·지연 주입·ThreadSanitizer 중 상황에 맞는 재현·탐지 방법을 선택하고 각 방법의 한계를 설명한다.

## 배경: 왜 이것이 존재하는가

단일 코어 시대의 프로그램은 하나의 실행 흐름이었다. 멀티코어가 표준이 되면서 성능은 동시 실행에서 나오게 됐고, 주류 언어들은 **공유 메모리 위의 스레드**를 동시성의 기본 모델로 선택했다. 이 선택의 이득은 통신 비용이 거의 없다는 것이다 — 스레드끼리는 같은 주소 공간의 변수를 읽고 쓰면 된다. 대가는 정확히 같은 지점에 있다. **모든 공유 변수가 잠재적 통신 채널이 되고, 개발자가 의도하지 않은 통신(간섭)도 함께 열린다.**

대안이 없었던 것은 아니다. 메시지 전달(Erlang의 액터, Go의 채널 지향 스타일)은 공유를 통신으로 대체해 이 문제를 구조적으로 줄인다. 그러나 그 언어들조차 내부 구현과 성능 경로에서는 공유 메모리를 쓰고, 주류 런타임(JVM, .NET, C/C++, 커널 자체)은 공유 메모리 스레드 위에 서 있다. 어떤 모델을 쓰든 그 아래에서 무슨 일이 벌어지는지 설명할 모델은 필요하다.

문제의 핵심은 [인트로에서 세운 대로](./00-introduction.md) 코드와 실행의 관계가 1:1에서 1:N으로 바뀐다는 것이다. 이 문서는 그 N을 다루는 도구를 만든다.

## 핵심 개념

### interleaving — 실행 공간의 기본 모델

두 스레드가 동시에 실행될 때 결과를 추론하는 기본 모델은 이렇다.

1. 각 스레드 안에서 연산은 프로그램 순서대로 실행된다.
2. 스레드 사이의 연산은 임의로 섞인다(interleave). 어떤 섞임이 나올지는 스케줄러·코어 배치·캐시 상태가 정하며, 프로그램은 선택할 수 없다.
3. 프로그램이 옳다는 것은 **가능한 모든 섞임에서** 불변식이 유지된다는 뜻이다.

이 모델은 단순화다 — 컴파일러와 하드웨어는 연산을 재배열하므로 동기화 없는 코드의 실제 실행 공간은 interleaving보다 넓다(뒤의 data race 절과 [8a.2](./02-synchronization-and-memory-models.md)에서 다룬다). 그러나 동기화가 올바른 프로그램은 interleaving 모델로 추론해도 된다는 것이 언어들의 공통 약속이므로, 이 모델을 기본으로 세우고 넓어지는 지점을 예외로 다루는 것이 올바른 순서다.

섞임의 수는 조합적으로 폭발한다. 두 스레드가 각각 연산 n개를 실행하면 가능한 interleaving은 이항 계수 C(2n, n)이다 — 연산 3개씩만 돼도 20가지, 10개씩이면 18만 가지가 넘는다. 테스트 한 번은 이 공간에서 표본 하나를 뽑는다. 실행 공간을 전수 검사하는 테스트는 실무 규모에서 존재하지 않는다.

### 원자성의 단위 — 소스 한 줄은 경계가 아니다

interleaving의 단위는 소스 코드의 줄이 아니라 실행의 원자적 연산이다. `counter++`는 하나의 문장이지만 실행은 세 단계다.

```text
load  r ← counter     ; 읽기
add   r ← r + 1       ; 수정
store counter ← r     ; 쓰기
```

두 스레드가 각각 한 번씩 `counter++`를 실행하는 경우, 세 단계가 섞이는 방식에 따라 결과는 2가 아니라 {1, 2}의 집합이다. 두 스레드가 모두 0을 읽는 섞임에서는 둘 다 1을 쓰고, 증가 하나가 사라진다(lost update).

실제로 관찰해 보자. worker 4개가 `SharedArrayBuffer` 위의 카운터를 각자 100만 번 증가시킨다.

```js
// counter-race.mjs — 4개 worker가 공유 카운터를 각자 100만 번 증가시킨다
// 실행: node counter-race.mjs [atomic]
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const THREADS = 4;
const ITERS = 1_000_000;

if (isMainThread) {
  const useAtomic = process.argv[2] === 'atomic';
  const sab = new SharedArrayBuffer(4);
  const workers = Array.from({ length: THREADS }, () =>
    new Worker(fileURLToPath(import.meta.url), { workerData: { sab, useAtomic } }));
  await Promise.all(workers.map((w) => new Promise((r) => w.on('exit', r))));
  const counter = new Int32Array(sab);
  console.log(`기대값 ${THREADS * ITERS}, 실제값 ${counter[0]}, 소실 ${THREADS * ITERS - counter[0]}`);
} else {
  const counter = new Int32Array(workerData.sab);
  if (workerData.useAtomic) {
    for (let i = 0; i < ITERS; i++) Atomics.add(counter, 0, 1);
  } else {
    for (let i = 0; i < ITERS; i++) counter[0] = counter[0] + 1; // 읽기-수정-쓰기
  }
}
```

세 번 실행한 결과다.

```text
기대값 4000000, 실제값 1091569, 소실 2908431
기대값 4000000, 실제값 1131686, 소실 2868314
기대값 4000000, 실제값 1034581, 소실 2965419
```

400만 번 중 290만 번 — 소실이 예외가 아니라 다수다. 겹침이 상시적인 워크로드에서 read-modify-write의 충돌은 희귀 사건이 아니다. 실행마다 값이 다르다는 점도 놓치지 말자. 이것이 비결정성의 실측이다. 같은 프로그램을 `node counter-race.mjs atomic`으로 실행하면 — `Atomics.add`는 읽기-수정-쓰기를 하나의 원자적 연산으로 만든다 — 소실은 정확히 0이 된다.

### check-then-act — 검사와 행동 사이의 창

read-modify-write가 한 변수 안의 race라면, check-then-act는 논리 수준의 race다.

```js
if (stock >= quantity) {   // 검사
  // ← 이 사이에 다른 실행이 stock을 바꿀 수 있다: race window
  stock -= quantity;       // 행동
}
```

검사가 참이었다는 사실은 행동하는 시점의 보장이 아니다. 검사와 행동 사이의 시간 — **race window** — 동안 다른 스레드가 같은 검사를 통과하면 불변식(`stock >= 0`)이 깨진다. 파일 존재를 확인한 뒤 여는 코드, 캐시에 없음을 확인한 뒤 채우는 코드, 초기화 여부를 확인한 뒤 초기화하는 코드(지연 초기화)가 모두 같은 구조다. 파일시스템에서는 이 패턴에 TOCTOU(time-of-check to time-of-use)라는 이름이 붙어 있고 보안 취약점의 고전적 원천이다.

check-then-act가 read-modify-write보다 위험한 이유는 window의 크기다. `counter++`의 window는 명령어 몇 개지만, 검사와 행동 사이에 함수 호출·I/O·원격 API가 끼면 window는 밀리초에서 초 단위로 벌어진다. window가 클수록 충돌 확률이 커지고, 낮은 부하에서도 문제가 된다.

### 임계 구역 — 보호 대상은 코드가 아니라 불변식이다

두 패턴의 공통 해법은 "이 연산 묶음이 실행되는 동안 다른 실행이 끼어들지 못하게 한다"는 것이고, 그 묶음 구간을 **임계 구역(critical section)**이라 한다. 여기서 정확히 세워야 할 관점이 있다. 임계 구역의 경계를 정하는 기준은 코드의 모양이 아니라 **불변식**이다.

"재고는 0 이상이고, 차감 합계는 주문 합계와 같다"라는 불변식이 있다면, 이 불변식을 일시적으로 깨뜨렸다가 복원하는 연산 전체 — 검사부터 행동까지 — 가 하나의 임계 구역이어야 한다. 검사만, 혹은 행동만 보호하는 것은 자물쇠를 문 반쪽에만 다는 것이다. 8a.2에서 볼 락 범위 결정, 그리고 [챕터 11의 트랜잭션](../ch-11/04-transactions-and-concurrency-control.md)이 모두 이 관점의 연장이다.

### data race와 race condition — 이름이 다른 이유

두 용어는 자주 섞여 쓰이지만 다른 것을 가리키고, 구분이 실무 판단을 바꾼다.

- **data race**: 서로 다른 스레드의 두 접근이 같은 메모리 위치에, 동기화 관계 없이, 적어도 하나는 쓰기로 접근하는 것. **언어 메모리 모델이 정의하는 계약 위반**이며, 코드에 대한 기계적 판정이 가능하다.
- **race condition**: 실행들의 상대적 타이밍에 따라 프로그램이 잘못된 결과에 도달하는 것. **요구사항에 대한 논리 오류**이며, 무엇이 "잘못"인지는 불변식이 정한다.

둘은 겹치지만 일치하지 않는다. 위의 JS 카운터는 data race이면서 race condition이다. 반면 모든 접근을 락으로 감쌌지만 검사와 행동을 다른 락 구간에 나눠 넣은 코드는 data race가 없어도 race condition이 있다. 거꾸로 통계용 카운터 하나가 조금 틀려도 된다고 "허용"하는 코드는 race condition이 아니라고 주장할 수 있어도 data race라는 계약 위반은 그대로다.

계약 위반 쪽의 결과는 "값이 조금 틀리는" 수준이 아니다. C/C++에서 data race는 **미정의 동작(undefined behavior)**이다. 실행해서 확인하자. 같은 카운터를 C로 옮긴 코드다.

```c
// counter_race.c — 4개 스레드가 공유 카운터를 각자 100만 번 증가시킨다 (핵심부)
long counter = 0;

void *work(void *arg) {
  for (int i = 0; i < ITERS; i++)
    counter++; // 읽기-수정-쓰기
  return NULL;
}
```

`clang -O0`으로 빌드해 세 번 실행하면 JS와 같은 소실이 보인다.

```text
기대값 4000000, 실제값 980843
기대값 4000000, 실제값 1045638
기대값 4000000, 실제값 1022844
```

그런데 `clang -O2`로 빌드하면 세 번 모두 정확히 4000000이 나온다. 고쳐진 것일까? 어셈블리를 보면 반대다.

```text
_work:                       ; clang -O2 출력 (arm64, 일부)
  ldr  x9, [x8, _counter@PAGEOFF]   ; counter를 한 번 읽고
  add  x9, x9, #244, lsl #12        ; +999424
  add  x9, x9, #576                 ; +576  → 합계 +1000000
  str  x9, [x8, _counter@PAGEOFF]   ; 한 번 쓴다
```

컴파일러가 루프 전체를 "한 번 읽고, 100만을 더해, 한 번 쓴다"로 접었다. 스레드당 race window가 명령어 서너 개로 줄어 충돌이 거의 일어나지 않을 뿐, race는 그대로다. 소스 코드와 실행의 대응이 끊어졌다는 것 — 최적화 수준 하나로 "75% 소실"과 "항상 정답"을 오간다는 것 — 이야말로 미정의 동작의 실체다. 컴파일러는 data race가 없다는 전제 아래 최적화하기로 언어와 계약했고, 전제를 어긴 프로그램에는 어떤 실행이든 허용된다. 잘 동작하는 것처럼 보이는 실행도 그중 하나다.

이 구분에서 실무 규칙이 나온다. **data race는 결과가 무해해 보여도 항상 제거한다**(계약 위반은 컴파일러·하드웨어가 바뀌면 임의로 배신한다). **race condition은 불변식을 기준으로 판단한다**(도구가 아니라 사람이 요구사항을 알아야 한다).

### 왜 가끔만, 왜 프로덕션에서만 실패하는가

이제 인트로의 질문에 답할 수 있다. 버그의 발생 확률은 대략 이렇게 결정된다.

```text
발생 확률 ∝ 겹침의 빈도 × (race window 크기 / 연산 간격)
```

- **부하**가 겹침의 빈도를 정한다. 초당 요청 1건이면 window가 1ms여도 충돌은 드물고, 초당 1만 건이면 상시적이다. 프로덕션의 피크가 정확히 이 조건이다.
- **코어 수와 배치**가 겹침의 물리적 가능성을 정한다. 개발 노트북의 저부하 실행과 서버의 멀티코어 병렬 실행은 다른 표본 공간이다.
- **관찰 도구가 window를 움직인다.** 로그 I/O, 디버거의 중단점, 프로파일러의 오버헤드는 스레드의 상대 속도를 바꿔 문제의 섞임이 뽑힐 확률을 낮추거나 (드물게) 높인다. 로그를 넣었더니 사라진 버그는 고쳐진 것이 아니라 표본 분포가 바뀐 것이다.

### 재현 — 확률을 통제하는 두 지렛대

발생 확률의 식은 재현 전략도 알려 준다. 확률을 이루는 두 항을 의도적으로 키우면 된다.

1. **겹침 증폭(스트레스)**: 스레드 수와 반복 횟수를 올려 표본을 대량으로 뽑는다. 위의 카운터 예제가 이 방식이다 — 한 번의 증가로는 소실을 거의 볼 수 없지만 400만 번이면 매 실행 재현된다.
2. **window 확대(지연 주입)**: 의심 지점의 검사와 행동 사이에 의도적 지연(sleep, yield)을 넣어 window를 밀리초 단위로 벌린다. 확률이 낮아 스트레스로도 안 잡히는 race를 결정적으로 만드는 데 효과적이며, 가설 검증에 특히 유용하다 — "여기가 window라면 지연을 넣었을 때 실패율이 치솟아야 한다"는 예측을 실험으로 바꾼다.

두 방법 모두 버그의 부재를 증명하지 못한다는 한계는 같다. 표본을 늘릴 뿐이다.

### 탐지 — ThreadSanitizer의 원리와 한계

data race는 계약 위반이라 기계적 판정이 가능하고, 그 판정을 실행 중에 수행하는 도구가 **ThreadSanitizer(TSan)**다. clang·GCC(C/C++), Go(`-race`), Rust(nightly) 등이 지원한다. 위의 C 카운터를 검사해 보자.

```sh
clang -O1 -g -fsanitize=thread -o counter_race_tsan counter_race.c
./counter_race_tsan
```

```text
WARNING: ThreadSanitizer: data race (pid=91766)
  Write of size 8 at 0x00010486c000 by thread T3:
    #0 work counter_race.c:14

  Previous write of size 8 at 0x00010486c000 by thread T2:
    #0 work counter_race.c:14

  Location is global 'counter' at 0x00010486c000
SUMMARY: ThreadSanitizer: data race counter_race.c:14 in work
```

동작 원리는 8a.2에서 세울 happens-before 관계의 추적이다. TSan은 모든 메모리 접근과 동기화 연산을 계측해, 두 접근 사이에 동기화가 만드는 순서 관계가 있는지 검사한다. 관계없이 겹친 쓰기를 발견하면 — 실제 값이 깨졌는지와 무관하게 — 보고한다. 그래서 TSan은 "운 좋게 값이 맞은" 실행에서도 race를 잡는다. 재현에 의존하는 스트레스 테스트와 질적으로 다른 이유다.

한계도 원리에서 나온다. **TSan은 실행된 경로의 접근만 본다.** 테스트가 밟지 않은 분기의 race는 보고할 수 없으므로, TSan을 통과했다는 것은 "실행된 경로에 data race가 없다"까지다. 또한 TSan이 판정하는 것은 data race뿐이다 — 동기화는 있으나 논리가 틀린 race condition(다음 절의 예가 정확히 이것이다)은 원리적으로 탐지 대상이 아니다. 비용도 있다: 메모리 5~10배, 실행 시간 2~20배가 공식 문서가 밝히는 오버헤드라 프로덕션이 아니라 테스트 환경의 도구다.

## 실무 관점

### 싱글 스레드 이벤트 루프에도 race condition은 있다

"Node.js는 싱글 스레드라 동시성 버그가 없다"는 통념을 검사하자. 이벤트 루프 모델에서 코드는 `await`까지 원자적으로 실행된다 — interleaving의 단위가 명령어가 아니라 **await 사이의 구간**이 된다. data race는 구조적으로 사라진다. 그러나 check-then-act의 검사와 행동이 `await`로 갈라지는 순간, race window는 그대로 돌아온다.

```js
// withdraw-race.mjs — 스레드는 하나, 그래도 race condition은 남는다
let balance = 100;

async function withdraw(amount) {
  if (balance >= amount) {                      // 검사
    await new Promise((r) => setTimeout(r, 10)); // 외부 API 호출을 흉내 낸 대기
    balance -= amount;                           // 행동
    return true;
  }
  return false;
}

const results = await Promise.all([withdraw(80), withdraw(80)]);
console.log(`인출 결과 ${JSON.stringify(results)}, 잔액 ${balance}`);
```

```text
인출 결과 [true,true], 잔액 -60
```

두 인출 모두 잔액 검사를 통과했다 — 첫 번째 인출이 `await`에서 멈춘 사이 두 번째가 같은 검사를 통과하기 때문이다. 스레드도, data race도, 비결정성조차 없다(이 예제는 매번 실패한다). 그래도 race condition이다. 이벤트 루프가 없애 주는 것과 없애 주지 않는 것의 경계가 이것이고, TSan 같은 도구가 이 버그에 침묵하는 이유이기도 하다. 같은 구조가 goroutine 사이, async 태스크 사이, 그리고 **서로 다른 서버 인스턴스 사이**(DB를 공유 상태로 하는 check-then-act)에서 반복된다 — 마지막 형태는 [챕터 11의 트랜잭션 격리](../ch-11/04-transactions-and-concurrency-control.md)가 다루는 문제다.

### 전형 패턴을 이름으로 알아두기

리뷰에서 race를 찾는 현실적인 방법은 모든 interleaving을 상상하는 것이 아니라, 공유 상태 위의 전형 패턴을 알아보는 것이다.

| 패턴 | 형태 | 전형 사례 |
|------|------|-----------|
| read-modify-write | `x = f(x)` | 카운터, 잔액, 집계 갱신 |
| check-then-act | `if (p(x)) act(x)` | 재고 확인 후 차감, 파일 존재 확인 후 열기, 중복 요청 검사 |
| 지연 초기화 | `if (!inst) inst = create()` | 싱글턴, 캐시 미스 채우기, 연결 풀 |
| 복합 불변식 | 두 변수를 각각 갱신 | 잔액 이체(출금+입금), 컬렉션과 크기 카운터 |

넷 모두 "여러 접근이 하나의 불변식을 공유하는데 원자적 경계가 없다"는 같은 구조의 변형이다. 공유 상태를 도입하는 코드 리뷰라면 이 패턴이 보이는 즉시 "불변식이 무엇이고 임계 구역은 어디까지인가"를 물어야 한다.

### 통념 검증: "만 번 돌려서 통과했으니 race는 없다"

이 문서의 모델로 반박할 수 있다. 만 번의 통과는 실행 공간에서 만 개의 표본이 무사했다는 뜻이고, 표본 추출의 분포는 테스트 환경의 부하·코어·타이밍에 묶여 있다. window가 좁은 race는 프로덕션 조건에서만 의미 있는 확률로 뽑힌다. 증거로서의 가치가 없는 것은 아니다 — 실패했다면 확실한 반증이다. 비대칭이 핵심이다: **테스트는 race의 존재를 증명할 수 있지만 부재를 증명할 수 없다.** 부재 쪽 증거는 도구(TSan, data race에 한해)와 설계(공유 제거, 8a.2의 동기화 규율)에서 온다.

## 더 깊이

### data race를 미정의 동작으로 정의한 이유

"data race도 그냥 마지막 쓰기가 이기는 것으로 정의하면 되지 않나"라는 의문은 자연스럽다. 그렇게 하지 않은 이유는 성능 계약이다. 모든 메모리 접근이 관찰 가능한 순서를 가져야 한다면, 컴파일러는 레지스터 캐싱·루프 불변 이동·명령 재배열 같은 기본 최적화를 포기해야 하고 하드웨어는 [store buffer와 비순차 실행](../ch-7/01-cpu-and-pipelines.md)을 숨길 수 없게 된다. C++11 메모리 모델(과 이를 따른 C11)은 반대 방향의 계약을 선택했다 — 프로그램이 data race를 만들지 않는 한 순차적 일관성을 보이는 것처럼 실행하고(DRF-SC), 그 대가로 race 없는 프로그램에 대한 공격적 최적화를 허용한다. 위에서 본 `-O2`의 루프 접기가 바로 이 계약이 허용한 최적화다. Boehm의 "Threads Cannot Be Implemented as a Library"는 이 계약이 라이브러리 수준에서는 성립할 수 없고 언어 명세에 있어야 하는 이유를 보인 논문이다. 계약의 나머지 절반 — 동기화가 무엇을 약속하는가 — 은 8a.2에서 세운다.

### Java의 선택 — race가 있어도 미정의는 아니다

같은 문제에 Java는 다른 답을 골랐다. JVM은 메모리 안전과 보안 샌드박스를 약속하므로 race가 임의 동작으로 번지게 둘 수 없었고, JLS 17장은 data race가 있는 프로그램에도 "각 읽기는 어떤 쓰기의 값을 본다" 수준의 보장을 남겼다(대신 어느 쓰기인지는 놀랍도록 반직관적일 수 있다). 미정의 동작 대신 약한 정의를 준 이 선택은 안전성을 얻고 최적화 여지와 명세의 단순함을 지불했다 — 같은 트레이드오프 축 위의 다른 점이다.

## 정리

- 동시 실행의 기본 모델은 interleaving이다. 스레드 안의 순서는 유지되고 스레드 사이는 임의로 섞이며, 옳음은 가능한 모든 섞임에서의 불변식 유지를 뜻한다.
- 원자성의 단위는 소스 줄이 아니다. `counter++`는 세 연산이고, 4개 worker × 100만 증가에서 72%가 소실되는 것을 실측했다.
- check-then-act는 검사와 행동 사이의 race window가 문제이며, window에 I/O가 끼면 확률은 급증한다.
- data race는 언어 계약 위반(C/C++에서 미정의 동작 — 최적화 수준에 따라 증상이 사라지는 것까지 관찰했다), race condition은 불변식에 대한 논리 오류다. 전자는 무조건 제거하고 후자는 불변식으로 판단한다.
- 재현은 겹침 증폭과 window 확대로, 탐지는 TSan으로 한다. TSan은 실행된 경로의 data race만 보며, await 경계의 race condition 같은 논리 오류에는 침묵한다.

## 확인 문제

**1.** 두 스레드가 각각 `counter++`를 한 번씩 실행한다(초기값 0). 가능한 최종 값을 모두 나열하고, 각 값이 나오는 interleaving을 load/add/store 수준에서 제시하라.

::: details 정답과 해설
가능한 값은 1과 2다. 2는 한 스레드의 load-add-store가 끝난 뒤 다른 스레드가 시작하는 모든 섞임에서 나온다. 1은 두 스레드의 load가 모두 store보다 앞서는 섞임에서 나온다 — 예: T1 load(0), T2 load(0), T1 store(1), T2 store(1). 두 증가가 모두 "실행됐지만" 하나의 효과가 사라졌다는 점이 lost update의 정의다. 0이 불가능하다는 것도 확인할 가치가 있다: 어떤 store든 실행되면 값은 최소 1이다.
:::

**2.** 팀원이 조회수 카운터의 data race를 보고받고 "통계용이라 몇 개 틀려도 무방하니 수정하지 않겠다"고 결정했다. 이 판단을 data race와 race condition의 구분으로 평가하라. (구현 언어가 C++인 경우와 Java인 경우를 나눠 답하라.)

::: details 정답과 해설
"몇 개 틀려도 된다"는 race condition 관점의 판단이고, 불변식을 느슨하게 정의한 것으로 성립할 수 있다. 그러나 data race는 별개의 계약 위반으로 남는다. C++에서는 미정의 동작이라 "몇 개 틀리는" 것이 보장 범위가 아니다 — 본문의 관찰처럼 컴파일러는 race 부재를 전제로 변환하므로, 찢어진 값이나 본문의 루프 접기 같은 변환에 따른 임의 동작이 허용된다. 수정하지 않기로 했다면 최소한 relaxed atomic으로 바꿔 계약 위반만 제거하는 것이 옳다(비용은 8a.2의 측정 기준 무시할 수준이다). Java라면 미정의 동작은 아니므로 "오래된 값을 볼 수 있는 카운터"로 결정이 성립할 여지가 있지만, long 카운터는 64비트 접근의 원자성이 보장되지 않아 찢어진 읽기가 가능하다는 점까지 확인해야 한다.
:::

**3.** 어떤 서비스에서 같은 쿠폰이 드물게 두 번 사용되는 버그가 보고됐다. 코드는 "사용 여부를 조회하고, 미사용이면 사용 처리한다"이며 TSan을 포함한 테스트 스위트는 전부 통과한다. 버그의 구조를 지목하고, 재현 계획을 세워라.

::: details 정답과 해설
check-then-act다 — 조회(검사)와 사용 처리(행동) 사이가 race window이고, 같은 쿠폰의 두 요청이 모두 "미사용"을 읽으면 둘 다 사용 처리에 도달한다. TSan이 침묵하는 이유는 두 가지 중 하나다: 각 접근이 개별적으로는 동기화되어 있어(DB 쿼리, 락 걸린 조회) data race가 아니거나, 요청이 서로 다른 프로세스·인스턴스에서 실행돼 도구의 시야 밖이다. 재현은 window 확대가 효과적이다 — 조회와 사용 처리 사이에 의도적 지연을 주입한 뒤 같은 쿠폰으로 동시 요청 2개를 보내면 결정적으로 재현된다. 수정은 검사와 행동을 하나의 원자적 경계로 묶는 것이며, 단일 프로세스라면 8a.2의 상호 배제, 여러 인스턴스라면 DB의 원자적 조건부 갱신이나 유니크 제약(챕터 11)이 그 경계가 된다.
:::

## 참고 자료

- Shan Lu et al., ["Learning from Mistakes — A Comprehensive Study on Real World Concurrency Bug Characteristics"](https://dl.acm.org/doi/10.1145/1346281.1346323) (ASPLOS 2008) — 실제 오픈소스의 동시성 버그 105건을 분석해 원자성 위반과 순서 위반이 데드락 외 버그의 97%임을 보인 실증 연구. 본문의 패턴 분류가 현실을 덮는 근거다.
- Hans-J. Boehm, ["Threads Cannot Be Implemented as a Library"](https://www.hpl.hp.com/techreports/2004/HPL-2004-209.pdf) (PLDI 2005) — 스레드 의미론이 언어 명세에 있어야 하는 이유. data race가 미정의 동작인 설계 배경을 이해할 때 읽는다.
- [ThreadSanitizer 공식 문서](https://clang.llvm.org/docs/ThreadSanitizer.html) — 지원 플랫폼, 오버헤드 수치, 플래그. 본문이 인용한 성능 특성의 출처다.
- ECMA-262, [Memory Model](https://tc39.es/ecma262/#sec-memory-model) — `SharedArrayBuffer`와 `Atomics`의 원자성·순서 보장을 정의하는 1차 자료. JS 카운터 예제가 기대는 계약이다.
- Remzi Arpaci-Dusseau, Andrea Arpaci-Dusseau, [*OSTEP* — Concurrency and Threads](https://pages.cs.wisc.edu/~remzi/OSTEP/threads-intro.pdf) — 스레드와 race의 교과서적 도입. 본문과 다른 경로의 설명이 필요할 때 참조한다.
