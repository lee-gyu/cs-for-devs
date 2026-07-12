# 4.2 타입 안전성과 추론 — 실행하지 않고 무엇을 배제할 수 있는가

타입 검사기는 미래의 값을 맞히지 않는다. 식이 만들 수 있는 값과 허용할 연산을 **정적으로 근사**하고, 그 근사끼리 모순되는 프로그램을 거부한다. 이 문서는 타입 판단을 평가 규칙과 나란히 읽고, 타입 변수에 대한 제약을 생성·단일화해 `let` 다형성의 principal type을 구한다.

## 학습 목표

- 정적/동적 검사와 강/약 타입이라는 서로 다른 분류 축을 구분한다.
- 타입 환경과 `Γ ⊢ e : τ` 판단을 읽고 Toy 언어 식에 적용한다.
- progress와 preservation이 약속하는 타입 안전성과 약속하지 않는 성질을 구분한다.
- 제약 생성, substitution, occurs check, 단일화를 추적한다.
- `let` 일반화와 사용 지점 인스턴스화로 다형성이 생기는 과정을 설명한다.

## 배경: 타입은 값이 아니라 값의 근사다

`if condition then left else right`가 실행될 때는 condition이 고른 branch 하나만 값이 된다. 타입 검사 시점에는 어느 branch인지 모를 수 있으므로 두 branch가 같은 종류의 결과를 낸다는 보수적인 계약을 요구한다. 타입 `Number`는 정확한 값 0, 1, 2를 뜻하지 않고 숫자 연산을 허용할 값들의 집합을 근사한다.

근사는 필연적으로 정보를 버린다. `10 / 0`의 두 피연산자는 모두 `Number`이므로 단순 타입 시스템은 허용하지만 실행은 실패할 수 있다. 반대로 `if complicatedProof then 1 else false`가 실제로는 항상 숫자 branch만 실행되더라도 condition을 증명하지 못하는 타입 검사기는 거부한다. 건전성을 얻는 정적 분석은 안전한 일부 프로그램을 거부할 수 있다.

## 핵심 개념

### 정적/동적과 강/약은 같은 축이 아니다

정적 타입 검사(static type checking)는 실행 전에 프로그램 표현을 검사하고, 동적 타입 검사(dynamic type checking)는 실행 중 실제 값에 연산을 적용할 때 검사한다. 이는 **검사 시점**의 축이다.

강타입/약타입은 표준화된 이분법이 아니다. 보통 서로 다른 종류의 값 사이에 암묵 변환을 얼마나 허용하는지, 메모리를 다른 타입으로 재해석하는 연산을 얼마나 노출하는지 같은 **정책 강도**를 가리킨다. 따라서 "정적이면 강하고 동적이면 약하다"는 분류는 성립하지 않는다. Python은 동적으로 검사하지만 `1 + "2"`를 거부하고, C는 정적으로 검사하면서 정수·포인터 변환과 cast로 추상화 경계를 낮출 수 있다.

언어를 비교할 때는 모호한 라벨 대신 다음을 묻는다.

- 어떤 시점에 어떤 연산을 거부하는가?
- 암묵 변환은 정확히 어느 쌍에 허용되는가?
- `cast`, `any`, FFI처럼 검사를 우회하는 경계는 무엇인가?
- 경계 실패는 compile error, exception, undefined behavior 중 무엇인가?

### 타입 환경과 판단식을 읽는다

타입 환경 `Γ`(감마)는 이름을 타입 또는 타입 스킴에 연결한다. 판단식

```text
Γ ⊢ e : τ
```

는 "환경 Γ 아래에서 식 e에 타입 τ를 부여할 수 있다"고 읽는다. 실행 결과가 τ라는 예언이 아니라 아래 규칙으로 유도 가능하다는 주장이다.

| 식 | 타입 규칙의 의사 코드 | 평가 규칙과의 관계 |
|---|---|---|
| `42` | `type(42) = Number` | 값 자체를 반환 |
| `x` | `type(x) = lookup(Γ, x)` | 값 환경이 아니라 타입 환경 조회 |
| `a + b` | `a:Number, b:Number ⟹ Number` | 실제 숫자 연산 전에 operand 종류 제한 |
| `if c then t else f` | `c:Boolean, t:α, f:α ⟹ α` | 실행은 한 branch, 검사는 둘 다 |
| `fun x -> body` | `Γ,x:α ⊢ body:β ⟹ α→β` | closure 환경 대신 타입 가정 확장 |
| `callee(arg)` | `callee:α→β, arg:α ⟹ β` | 호출 전에 입력·출력 관계 확인 |
| `let x=v in body` | `v:τ`, 일반화 후 `Γ,x:σ ⊢ body:ρ` | 값 대신 type scheme을 환경에 저장 |

예를 들어 `fun x -> x + 1`에서 매개변수에 아직 타입이 없으므로 새 변수 `'a`를 준다. `+` 규칙이 `'a = Number` 제약을 만들고 결과는 `Number`이므로 함수 타입은 `Number -> Number`가 된다.

### 타입 오류는 규칙을 더 적용할 수 없는 상태다

`true + 1`은 런타임에서 우연히 무엇이 되는지를 묻기 전에 `+` 규칙의 전제인 두 `Number`를 만족하지 못한다. `if true then 1 else false`는 두 branch의 공통 타입 제약 `Number = Boolean`이 풀리지 않는다. 타입 오류는 "개발자의 의도가 틀렸다"가 아니라 **선택한 타입 규칙으로 유도할 수 없다**는 뜻이다.

이 관점은 진단 설계에도 중요하다. 추론기가 마지막에 "unification failed"만 보여 주면 사용자는 규칙과 소스의 연결을 잃는다. 제약을 만든 AST span, expected/actual type, callable 위치를 보존해야 `TypeMismatch`, `NotCallable` 같은 도메인 진단으로 바꿀 수 있다.

### progress와 preservation — 타입 안전성의 두 축

작은 언어의 타입 안전성(type safety)은 흔히 두 정리의 조합으로 표현한다.

- **Progress**: 잘 타입된 닫힌 식은 이미 값이거나 다음 평가 단계로 진행할 수 있다. `true + 1`처럼 정의되지 않은 연산 앞에서 stuck되지 않는다.
- **Preservation**: `e : τ`인 식이 한 단계 평가되어 `e'`가 되면 `e' : τ`도 유지된다. 실행 중 갑자기 약속과 다른 종류의 값이 되지 않는다.

여기서 "닫힌 식"은 자유 변수가 없다는 조건이고, "stuck"은 언어가 값도 오류 결과도 규정하지 않은 상태다. 명시적으로 모델링한 exception이나 `DivisionByZero`는 타입 안전성 위반과 같지 않다. 타입 규칙이 그것의 부재를 약속했는지부터 확인해야 한다.

잘 타입됨은 다음을 일반적으로 보장하지 않는다.

- 종료와 응답 시간
- 수학적·비즈니스 논리의 정답
- 파일·네트워크·권한 같은 외부 효과의 성공
- 메모리·CPU·스토리지 한도 내 실행
- 타입에 표현하지 않은 예외의 부재

정제 타입(refinement type)은 `NonZero`, 효과 타입은 `throws IOError`, 선형·아핀 타입은 자원 사용 횟수처럼 근사의 경계를 넓힌다. 보장은 강해지지만 annotation, solver, 추론, 오류 설명 비용도 늘어난다.

### 타입 추론은 제약을 풀어 정적 타입을 찾는다

타입 추론은 실행 중 값의 타입을 보는 동적 타이핑이 아니다. AST에 fresh type variable을 배정하고 타입 규칙이 만드는 **동등성 제약**을 실행 전에 푼다.

```text
fun f -> fun x -> f(x)

f : 'a
x : 'b
f(x)의 결과 : 'c
호출 규칙의 제약 : 'a = 'b -> 'c
최종 타입 : ('b -> 'c) -> 'b -> 'c
```

제약을 만족시키는 치환(substitution)은 타입 변수를 타입으로 매핑한다. `S = {'a ↦ Number, 'b ↦ Boolean}`를 타입 `'a -> 'b`에 적용하면 `Number -> Boolean`이다. 새 치환을 만들기 전에 기존 치환을 재귀 적용해야 간접 관계가 남지 않는다.

### 단일화는 두 타입을 같게 만드는 가장 일반적인 치환을 찾는다

단일화(unification)의 핵심 경우는 네 가지다.

1. 같은 primitive끼리는 성공한다.
2. 타입 변수와 타입을 만나면 변수를 그 타입에 묶는다.
3. 함수끼리는 parameter와 result를 각각 단일화한다.
4. `Number`와 `Boolean`, primitive와 함수처럼 constructor가 다르면 실패한다.

```ts
unify('a, Number)                 => {'a ↦ Number}
unify('a -> 'b, Number -> Bool)  => {'a ↦ Number, 'b ↦ Bool}
unify(Number, Boolean)           => TypeMismatch
```

변수를 묶기 전에 occurs check가 필요하다. `fun x -> x(x)`에서 `x : 'a`, 호출 결과 `'b`라 두면 호출 규칙은 다음 제약을 만든다.

```text
'a = 'a -> 'b
```

오른쪽 안에 이미 `'a`가 있다. 이를 허용하면 `'a = ('a -> 'b) = (('a -> 'b) -> 'b) ...`인 무한 타입이 된다. occurs check는 변수가 대상 타입의 자유 변수 집합에 포함되면 `InfiniteType`으로 거부한다.

### `let`이 다형성의 경계다

함수 매개변수는 한 호출 안에서 단일형(monomorphic)이다. `fun f -> ...`의 `f`가 body 안에서 한 번은 숫자 함수, 한 번은 불리언 함수가 될 수는 없다. 반면 `let`에 완전히 계산된 함수 값을 묶으면 환경에 의존하지 않는 타입 변수를 일반화할 수 있다.

```text
let id = fun x -> x in ...

추론 타입: 'a -> 'a
현재 Γ에 자유로운 변수: 없음
일반화: id : ∀a. a -> a
```

`id`를 조회할 때마다 quantified variable을 fresh variable로 바꾸는 인스턴스화(instantiation)를 한다. 그래서 `id(1)`의 `'b`가 `Number`가 되어도 다음 `id(true)`는 새 `'c`로 시작해 `Boolean`이 될 수 있다.

### 공통 예제를 끝까지 추적한다

```text
let id = fun x -> x in
let ignored = id(1) in
id(true)
```

| 단계 | 생성 정보 | substitution / scheme |
|---|---|---|
| `fun x -> x` | `x:'a`, body 조회도 `'a` | 타입 `'a -> 'a` |
| `let id` | `'a`는 Γ에 자유롭지 않음 | `id : ∀a. a -> a` |
| 첫 `id` 조회 | `'a`를 fresh `'b`로 교체 | `'b -> 'b` |
| `id(1)` | `'b -> 'b = Number -> 'c` | `'b ↦ Number, 'c ↦ Number` |
| `let ignored` | 결과 `Number` | `ignored : Number` |
| 둘째 `id` 조회 | 새 fresh `'d` | `'d -> 'd` |
| `id(true)` | `'d -> 'd = Boolean -> 'e` | `'d ↦ Boolean, 'e ↦ Boolean` |
| 전체 | body 결과 | `Boolean` |

[실습 기준 구현](https://github.com/lee-gyu/cs-for-devs/tree/main/exercises/ch-4)의 `pnpm demo`는 이 순서를 `Constraint`, `Unify`, `Generalize`, `Instantiate` 이벤트로 출력한다. 이것은 Algorithm W와 같은 HM 결과를 내되 학습을 위해 제약 생성과 단일화 이벤트를 노출한 구성이다. **principal type**은 가능한 타입 중 임의의 하나가 아니라 다른 모든 해가 그 타입의 인스턴스가 되는 가장 일반적인 타입이다. `fun x -> x`의 `Number -> Number`도 해지만 principal type은 `'a -> 'a`다.

## 실무 관점: 추론 경계를 어디에 둘 것인가

### 다형 재귀는 자동 추론의 단순한 확장이 아니다

재귀 함수가 자기 자신을 서로 다른 타입 인스턴스로 호출하는 polymorphic recursion은 일반적인 HM 추론 범위를 벗어나며, annotation이 없으면 추론이 결정 불가능해질 수 있다. "compiler가 똑똑하면 알아낼 것"이 아니라 어떤 경계에서 개발자가 타입을 제공할지 정해야 한다. 공개 API나 복잡한 재귀 경계의 명시 타입은 문서이자 추론 탐색의 제한이다.

### mutation과 `let` 다형성은 그대로 결합할 수 없다

다형적인 reference를 만들고 한 타입의 값을 쓴 뒤 다른 타입으로 읽을 수 있다면 타입 안전성이 깨진다.

```text
let cell = ref (fun x -> x) in
cell := (fun n -> n + 1);
(!cell)(true)
```

`cell`을 매 사용마다 임의 타입으로 인스턴스화하면 숫자 함수가 저장된 동일 cell을 불리언 함수처럼 읽는다. ML 계열은 value restriction으로 일반화 대상을 syntactic value 또는 비확장 식으로 제한한다. Rust의 소유권, 불변 borrow와 가변 borrow의 분리도 자원과 aliasing을 타입 규칙 안으로 가져와 다른 경계를 만든다.

### 오류 메시지는 추론기의 내부 순서와 분리한다

제약 해결 순서가 바뀌면 `expected`와 `actual`의 방향이나 내부 변수 번호가 바뀔 수 있다. 사용자 진단은 source span과 언어 규칙을 기준으로 안정화하고, 타입 변수는 첫 등장 순서로 `'a`, `'b`처럼 정규화한다. trace는 교육과 디버깅에 유용하지만 compiler 내부 구현을 공개 API 계약으로 만들면 최적화가 어려워진다.

## 더 깊이: 건전성과 완전성

건전한(sound) 타입 시스템은 받아들인 프로그램이 약속한 오류를 일으키지 않게 한다. 완전한(complete) 분석은 실제로 안전한 모든 프로그램을 받아들인다. 일반 프로그램의 흥미로운 동적 성질에서는 둘을 동시에 완벽히 얻을 수 없으므로 언어는 보수적으로 거부하거나 escape hatch를 둔다.

`as`, `unsafe`, `any`, FFI는 타입 시스템이 사라진다는 뜻이 아니라 **증명 책임이 개발자 또는 경계 코드로 이동**한다는 뜻이다. 경계를 좁히고 런타임 검증을 배치하며 안전한 타입으로 즉시 변환해야 보장의 나머지 부분을 유지할 수 있다.

## 정리

- 타입은 실제 값이 아니라 가능한 값과 연산의 정적 근사다.
- `Γ ⊢ e : τ`는 타입 환경과 규칙으로 식의 타입을 유도할 수 있다는 판단이다.
- progress와 preservation은 stuck 방지와 타입 유지의 직관이며 종료·논리 정답·I/O 성공까지 보장하지 않는다.
- HM 추론은 fresh variable, 제약, substitution, 단일화, occurs check로 principal type을 구한다.
- `let`에서 일반화하고 조회 때마다 인스턴스화하므로 한 identity 함수를 여러 타입에 독립적으로 쓸 수 있다.

## 확인 문제

**1.** `fun f -> fun x -> f(f(x))`의 principal type을 제약으로 구하라.

::: details 정답과 해설
`f:'a`, `x:'b`라 둔다. 안쪽 `f(x)` 결과를 `'c`라 하면 `'a = 'b -> 'c`. 바깥 `f(...)` 결과를 `'d`라 하면 같은 f에 대해 `'a = 'c -> 'd`. 두 함수 타입을 단일화하면 `'b = 'c`이고 `'c = 'd`이므로 모두 같은 타입이다. 최종 타입은 `('t -> 't) -> 't -> 't`다. f가 body 안에서 단일형이라는 점이 핵심이다.
:::

**2.** `10 / 0`이 `Number`로 추론되는 구현에서 실행 시 `DivisionByZero`가 발생했다. progress 위반인가?

::: details 정답과 해설
언어가 `DivisionByZero`를 명시적 실행 진단으로 정의했다면 무규정 stuck 상태가 아니다. 더 중요하게는 `Number` 타입 규칙이 분모가 0이 아님을 약속하지 않는다. 0 나누기를 배제하려면 `NonZeroNumber` 같은 정제, 나눗셈 결과에 오류를 포함한 `Result`, 또는 별도 정적 분석이 필요하다. 어떤 선택도 새 annotation·분기·solver 비용을 만든다.
:::

**3.** `fun x -> x(x)`에서 occurs check를 생략하면 왜 단순히 "재귀 함수 타입"으로 처리할 수 없는가?

::: details 정답과 해설
제약은 `'a = 'a -> 'b`이고 `'a`를 풀 때 자기 자신을 포함한다. 유한한 HM 타입 트리로 해가 없으며 substitution 적용이 끝없이 확장된다. 명시적인 recursive type constructor와 fold/unfold 규칙을 가진 언어라면 별도 의미를 줄 수 있지만, 그것은 occurs check를 지운 HM이 아니라 타입 문법과 규칙을 확장한 다른 시스템이다.
:::

## 참고 자료

- Robin Milner, [“A Theory of Type Polymorphism in Programming”](https://homepages.inf.ed.ac.uk/wadler/papers/papers-we-love/milner-type-polymorphism.pdf) (1978) — `let` 다형성과 타입 안전성 결과의 원전이다.
- Luis Damas, Robin Milner, [“Principal Type-Schemes for Functional Programs”](https://www.samskivert.com/reviews/papers/2010/03/principal-type-schemes-for-functional-programs-damas-and-milner/) (1982) — Algorithm W와 principal type-scheme 결과를 다룬다.
- Benjamin C. Pierce, *Types and Programming Languages* (2002), Ch. 8–11, 22 — progress/preservation, 단순 타입 lambda calculus, 타입 재구성의 기준 설명이다.
- OCaml Manual, [Polymorphism and its limitations](https://ocaml.org/manual/5.3/polymorphism.html) — value restriction과 다형 재귀가 실제 언어의 추론 경계로 나타나는 방식을 확인한다.
