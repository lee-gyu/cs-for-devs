# 4.1 언어 의미론 — AST는 어떻게 값이 되는가

AST는 프로그램의 구조이지 실행 결과가 아니다. 변수와 함수가 있는 식을 값으로 만들려면 **이름을 찾을 환경, 함수를 만들 때 보존할 환경, 하위 식을 평가할 순서**가 필요하다. 이 문서는 `evaluate(expression, environment) -> value`라는 작은 인터페이스에서 그 선택이 스코프·closure·평가 전략으로 드러나는 과정을 추적한다.

## 학습 목표

- 구문과 실행 의미를 구분하고 환경 기반 big-step 평가 규칙을 적용한다.
- lexical scope와 dynamic scope의 차이를 환경 선택으로 설명한다.
- closure를 함수 코드와 정의 시점 환경의 쌍으로 구현하는 이유를 추적한다.
- strict와 lazy 평가에서 실행 횟수·부작용·종료 여부가 달라지는 조건을 판단한다.
- 명령형·객체지향·함수형 패러다임을 상태·제어·조합 방식으로 비교한다.

## 배경: 트리는 스스로 실행되지 않는다

parser가 `let x = 10 in x + 2`를 다음 AST로 만들었다고 하자.

```text
Let x
├─ value: Number 10
└─ body: Binary +
   ├─ Variable x
   └─ Number 2
```

트리에는 `x`가 10이라는 사실이 직접 적혀 있지 않다. `let`을 만났을 때 value를 평가하고 `x → 10`인 새 환경을 만든 뒤 body를 그 환경에서 평가한다는 **의미 규칙**이 관계를 만든다. 같은 AST에 `let`이 동시 바인딩인지 순차 바인딩인지, 이름을 정의 위치에서 찾는지 호출 위치에서 찾는지 다른 규칙을 주면 다른 언어가 된다.

형식 의미론은 이 선택을 구현과 분리해 명시한다. 여기서는 완전한 증명 대신 규칙을 TypeScript 의사 코드와 평가 추적으로 읽는다. big-step semantics를 쓰는 이유는 `식, 환경 ⇓ 값`처럼 시작과 끝을 직접 연결해 환경 변화가 잘 보이기 때문이다. 한 단계씩의 기계 상태나 비종료를 정밀하게 분석하려면 small-step semantics가 더 적합하다.

## 핵심 개념

### 환경은 이름에서 값으로 가는 지속적인 사슬이다

환경(environment)은 현재 scope의 바인딩과 바깥 환경 링크를 가진다.

```ts
type Environment<T> = {
  bindings: ReadonlyMap<string, T>;
  parent?: Environment<T>;
};

function lookup<T>(environment: Environment<T>, name: string): T | undefined {
  for (let current = environment; current; current = current.parent) {
    if (current.bindings.has(name)) return current.bindings.get(name);
  }
  return undefined;
}
```

새 scope는 기존 map을 수정하지 않고 한 노드를 앞에 붙인다. `let x = 1 in let x = 2 in x`의 body에서 환경은 `{x: 2} → {x: 1} → ∅`이고, 조회는 처음 만난 2를 반환한다. 이것이 shadowing이다. 바깥 binding을 삭제한 것이 아니라 같은 이름의 더 가까운 binding이 가린다.

변수 occurrence는 두 종류다. `fun x -> x + rate`에서 `x`는 함수가 묶는 **바인딩 변수**(bound variable)이고 `rate`는 함수 안에 정의가 없는 **자유 변수**(free variable)다. 자유 변수의 의미는 주변 환경이 공급한다. 식만 떼어내면 `rate`의 값을 결정할 수 없으므로 식과 환경을 함께 평가해야 한다.

### 평가 규칙을 코드로 읽는다

Toy 언어의 핵심 규칙은 다음과 같다. 이것은 parser나 최적화기가 아니라 evaluator의 계약이다.

```ts
function evaluate(expression: Expression, environment: ValueEnvironment): Value {
  switch (expression.kind) {
    case "number":
    case "boolean":
      return expression.value;

    case "variable":
      return lookup(environment, expression.name); // 없으면 UnboundVariable

    case "let": {
      const value = evaluate(expression.value, environment);
      return evaluate(expression.body, extend(environment, expression.name, value));
    }

    case "if": {
      const condition = evaluate(expression.condition, environment);
      return evaluate(condition ? expression.then : expression.otherwise, environment);
    }
  }
}
```

`if`는 선택된 branch만 평가한다. 이 규칙은 단순한 최적화가 아니라 관찰 가능한 의미다. `if true then 1 else 10 / 0`은 1이고 0 나누기는 발생하지 않는다. 두 branch를 먼저 평가하는 구현은 이 언어를 구현한 것이 아니다.

`let` 역시 순서가 중요하다. 이 언어의 비재귀 `let`은 value를 **기존 환경**에서 평가하고 body만 확장 환경에서 평가한다. 그래서 `let x = x in ...`의 오른쪽 `x`는 새 binding 자신을 볼 수 없다. 재귀 함수가 필요하면 먼저 비어 있는 cell을 환경에 넣고 closure를 만든 뒤 cell을 채우는 별도의 `let rec` 규칙이 필요하다. 이를 일반 `let`에 몰래 섞으면 초기화 전 읽기라는 새 상태가 생긴다.

### closure는 코드와 정의 환경의 쌍이다

함수 AST만 값으로 보관하면 자유 변수를 잃는다. 따라서 함수 값인 closure는 세 요소를 가진다.

```ts
type Closure = {
  parameter: string;
  body: Expression;
  environment: ValueEnvironment; // 정의 시점 환경
};
```

함수 식을 평가할 때 실행하지 않고 현재 환경을 저장한다. 호출할 때 callee와 argument를 평가한 뒤 closure의 환경을 매개변수 binding으로 확장해 body를 평가한다.

```ts
case "function":
  return { parameter: expression.parameter, body: expression.body, environment };

case "call": {
  const closure = evaluate(expression.callee, environment);
  const argument = evaluate(expression.argument, environment);
  const callEnvironment = extend(closure.environment, closure.parameter, argument);
  return evaluate(closure.body, callEnvironment);
}
```

다음 프로그램을 추적해 보자.

```text
let x = 10 in
let addX = fun y -> x + y in
let x = 100 in
addX(5)
```

| 단계 | 식 | 사용 환경 | 결과 |
|---|---|---|---|
| 1 | `x = 10` | `E0` | `E1 = {x:10} → E0` |
| 2 | `fun y -> x + y` | `E1` | closure `(y, x+y, E1)` |
| 3 | `x = 100` | `{addX:closure} → E1` | `E3 = {x:100} → ...` |
| 4 | `addX(5)` | `E3`에서 callee·argument 조회 | closure와 5 |
| 5 | `x + y` | `{y:5} → E1` | `10 + 5 = 15` |

호출 지점의 `x = 100`은 body 환경에 들어가지 않는다. 이것이 lexical scope다. 이름의 의미가 소스의 중첩 구조와 함수 정의 위치로 결정되어 코드만 읽어도 추론 가능하다.

### dynamic scope는 호출 사슬을 환경으로 쓴다

dynamic scope evaluator는 호출 시 closure의 정의 환경 대신 **호출자 환경**을 확장한다.

```ts
const callEnvironment = extend(callerEnvironment, closure.parameter, argument);
```

위 프로그램은 이 규칙에서 105가 된다. `x`를 호출 시점의 `E3`에서 찾기 때문이다. dynamic scope는 로깅 context나 설정을 매개변수 없이 전파하는 데 편리하지만 함수 동작이 호출 사슬에 의존해 지역 추론과 리팩터링이 어렵다. 현대 언어의 `AsyncLocalStorage`, thread-local, implicit parameter는 dynamic scope와 비슷한 편의를 제한된 API로 복원한다. 다만 비동기 context는 런타임이 비동기 작업 사이의 **논리적 연결**을 추적한 것이며 실제 machine call stack과 같지 않다.

### lexical scope와 closure capture의 경계

lexical이라는 말만으로 capture 시점의 값이 복사된다는 뜻은 아니다. 대다수 언어에서 closure는 binding 또는 저장 위치를 공유할 수 있다.

```ts
let count = 0;
const next = () => ++count;
next(); // 1
next(); // 2
```

두 호출이 같은 mutable cell을 본다. loop variable capture 버그도 "closure가 잘못됐다"보다 **반복마다 binding을 새로 만드는가, 하나의 cell을 갱신하는가**로 설명해야 한다. 동시 실행에서 mutable capture는 데이터 경쟁과 수명 문제까지 만든다. 언어는 값 복사, 공유 cell, 소유권 이동 중 무엇을 기본으로 할지 선택한다.

### strict와 lazy — 인자를 언제 계산하는가

지금까지의 호출은 call-by-value, 즉 strict evaluation이다. callee body에 들어가기 전에 argument를 한 번 계산한다. lazy evaluation은 argument 대신 계산을 미룬 thunk를 전달하고 실제 사용 시 평가한다.

```text
(fun unused -> 42)(10 / 0)
```

| 전략 | 호출 시 동작 | 결과 |
|---|---|---|
| strict / call-by-value | `10 / 0`을 먼저 평가 | `DivisionByZero` |
| call-by-name | `unused`를 읽을 때마다 argument 평가 | 읽지 않으므로 42 |
| call-by-need | 최초 읽을 때 평가하고 memoize | 읽지 않으므로 42 |

call-by-name과 call-by-need는 모두 필요할 때까지 미루지만 반복 사용 비용이 다르다. `(fun x -> x + x)(expensive())`에서 call-by-name은 두 번, call-by-need는 한 번 실행한다. memoization은 thunk마다 "아직 계산 안 됨 / 계산 중 / 값" 상태와 저장 공간을 요구한다.

평가 전략은 종료 여부도 바꾼다. `(fun x -> 1)(loop())`는 strict에서 끝나지 않지만 lazy에서는 1이다. 부작용이 있으면 순서와 횟수가 모두 관찰된다. 그래서 lazy 언어는 효과의 순서를 타입이나 별도 구조로 명시하려 하고, strict 언어도 generator·promise·lazy collection처럼 지연 경계를 API로 제공한다.

### effect는 평가 순서를 관찰 가능하게 만든다

식 `f() + g()`에서 두 함수가 순수하다면 어느 것을 먼저 평가해도 결과가 같다. 전역 상태 변경, I/O, 예외 같은 effect가 있으면 순서가 의미의 일부가 된다. 참조 투명성(referential transparency)은 식을 그 값으로 치환해도 프로그램의 관찰 결과가 바뀌지 않는 성질이다. mutation과 effect는 이 치환을 일반적으로 깨뜨린다.

언어 명세가 operand 평가 순서를 고정하지 않는다면 최적화기는 자유를 얻지만 개발자는 순서 의존 코드를 쓸 수 없다. 순서를 고정하면 추론 가능성은 높아지지만 재배치 최적화의 여지가 줄어든다. "함수형이 빠르다/느리다"보다 effect가 어디에 드러나고 런타임이 어떤 변환 자유를 갖는지를 물어야 한다.

## 실무 관점: 패러다임은 상태·제어·조합의 선택이다

패러다임을 문법 목록으로 나누면 혼합 언어를 설명하기 어렵다. 세 질문으로 비교하면 설계 판단에 직접 연결된다.

| 관점 | 명령형 | 객체지향 | 함수형 |
|---|---|---|---|
| 상태 | 명시적 위치를 순서대로 변경 | 상태를 객체 identity와 캡슐화 | immutable value와 변환을 기본으로 격리 |
| 제어 | 문장 순서, loop, jump | message dispatch와 method call | 식 평가, 함수 합성, recursion |
| 조합 | procedure와 module | interface와 객체 그래프 | 고차 함수와 대수적 데이터 타입 |
| 주 경계 비용 | aliasing·순서 의존 | 숨은 mutable state·상속 결합 | effect 표현·할당·평가 모델 학습 |

현대 언어는 이 셋을 섞는다. 중요한 것은 라벨이 아니라 특정 코드에서 상태의 소유자가 누구인지, 제어 흐름이 어디에 드러나는지, 조합 단위가 어떤 계약을 갖는지다. 주문 처리에서 핵심 계산을 순수 함수로 두고 I/O를 바깥 orchestration에 모으는 것은 "함수형 언어로 바꾸기"가 아니라 effect 경계를 좁혀 테스트와 재시도를 단순하게 만드는 선택이다.

### 디버깅 체크리스트

- 예상과 다른 이름을 읽었다면 AST보다 먼저 scope chain과 binding 생성 시점을 출력한다.
- callback이 오래된 값을 본다면 값 snapshot인지 mutable cell capture인지 구분한다.
- 비동기 context가 사라졌다면 실제 stack이 아니라 런타임의 context 전파 경계를 확인한다.
- lazy collection의 중복 I/O가 의심되면 thunk가 memoize되는지, 몇 번 소비되는지 계측한다.
- 순서 의존 버그는 effect가 있는 하위 식과 언어가 보장하는 평가 순서를 함께 확인한다.

## 더 깊이: 구현 모델의 한계

환경 chain은 의미를 설명하기 좋지만 산업 런타임이 map을 매번 선형 탐색한다는 뜻은 아니다. 컴파일러는 lexical address `(몇 단계 바깥, 몇 번째 slot)`로 이름을 바꾸고 closure가 필요한 변수만 heap cell이나 closure record에 올릴 수 있다. escape analysis는 함수 밖으로 나가지 않는 closure를 stack에 두거나 allocation을 제거한다. 최적화 뒤 표현이 달라도 관찰 가능한 결과가 환경 규칙과 같아야 한다.

big-step 규칙은 `loop()`가 결과를 만들지 못한다는 사실을 하나의 유도로 보여 주기 어렵다. debugger의 step, 동시성 interleaving, 예외 전파를 정밀하게 모델링하려면 `⟨expression, environment, store⟩ → ⟨expression', environment', store'⟩` 형태의 small-step과 별도 store가 적합하다. 어떤 의미론을 택할지는 참/거짓이 아니라 분석할 질문에 달렸다.

## 정리

- AST가 값이 되려면 식과 환경을 함께 해석하는 평가 규칙이 필요하다.
- lexical scope는 함수 정의 환경을, dynamic scope는 호출 환경을 자유 변수 조회에 사용한다.
- closure는 코드와 정의 환경의 쌍이다. capture가 값 복사인지 mutable binding 공유인지는 별도 규칙이다.
- strict/lazy, 평가 순서, memoization은 예외·부작용·종료·비용을 바꾸므로 의미의 일부다.
- 패러다임은 키워드보다 상태의 위치, 제어의 표현, 조합 계약으로 판단한다.

## 확인 문제

**1.** `let rate = 2 in let scale = fun x -> x * rate in let rate = 10 in scale(3)`을 lexical scope와 dynamic scope로 각각 평가하라.

::: details 정답과 해설
lexical scope에서는 `scale` closure가 정의 시점의 `rate = 2` 환경을 저장하므로 6이다. dynamic scope에서는 함수 body의 `rate`를 호출 시점 환경에서 찾아 10을 읽으므로 30이다. 차이는 곱셈이나 AST가 아니라 호출 환경을 closure 환경과 caller 환경 중 무엇으로 확장했는지에서 생긴다.
:::

**2.** lazy API로 바꾼 뒤 동일한 데이터베이스 조회가 두 번 실행됐다. "lazy라서"보다 더 정확한 원인을 설명하라.

::: details 정답과 해설
지연 자체는 시점만 늦춘다. 같은 thunk를 사용할 때마다 다시 계산하는 call-by-name 또는 cold sequence이고 memoization·공유가 없어서 두 번 실행된 것이다. call-by-need라면 첫 결과를 저장해 한 번만 실행하지만 저장 공간, 실패 캐시 정책, 동시 최초 평가의 동기화 비용이 생긴다. effect가 있는 계산은 횟수가 의미이므로 API가 cold/hot 및 재사용 계약을 밝혀야 한다.
:::

**3.** 재귀를 지원하려고 일반 `let`의 value를 새 환경에서 평가하도록만 바꿨다. 어떤 새 오류 상태가 생기는가?

::: details 정답과 해설
새 binding의 값이 아직 계산되지 않았는데 오른쪽에서 자신을 읽을 수 있는 초기화 전 참조가 생긴다. 안전한 `let rec`는 함수처럼 지연된 값을 제한하거나, placeholder cell을 만들고 closure를 구성한 뒤 채우는 규칙과 초기화 상태 진단을 명시해야 한다. 일반 값까지 무제한 허용하면 `let x = x in x`의 의미를 정할 수 없다.
:::

## 참고 자료

- Benjamin C. Pierce, *Types and Programming Languages* (2002), Ch. 3–5 — big-step/small-step operational semantics와 평가 규칙을 읽는 기준이다.
- Matthias Felleisen et al., *Semantics Engineering with PLT Redex* (2009) — 실행 가능한 의미 규칙과 언어 모델 검증을 더 깊게 다룬다.
- Robert Nystrom, [*Crafting Interpreters — Functions*](https://craftinginterpreters.com/functions.html)와 [Closures](https://craftinginterpreters.com/closures.html) — 환경 기반 evaluator를 closure와 lexical resolution으로 확장하는 구현 자료다.
- SICP, [The Environment Model of Evaluation](https://sicp.sourceacademy.org/chapters/3.2.html) — substitution model이 상태와 closure에서 환경 모델로 확장되는 이유를 확인한다.
