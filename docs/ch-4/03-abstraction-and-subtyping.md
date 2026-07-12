# 4.3 추상화와 서브타이핑 — 무엇을 같은 인터페이스로 대체할 수 있는가

추상화는 서로 다른 값을 같은 계약으로 다루게 한다. 그러나 "비슷해 보인다"는 이유만으로 대체하면 호출자가 허용된 입력을 잃거나 mutable container에 잘못된 값을 쓸 수 있다. 이 문서는 **누가 어떤 연산을 생산하고 소비하는가**를 따라 다형성·서브타이핑·변성의 안전 조건을 세운다.

## 학습 목표

- parametric polymorphism과 ad-hoc polymorphism의 목적과 비용을 구분한다.
- nominal typing과 structural typing이 호환성의 증거를 어디에서 얻는지 설명한다.
- 레코드의 폭·깊이 서브타이핑을 읽기 전용과 mutable field에서 판단한다.
- 함수 parameter의 반공변성과 return의 공변성을 호출자 계약으로 설명한다.
- producer·consumer·mutable container에 맞는 변성을 선택하고 실제 언어의 완화 지점을 찾는다.

## 배경: 재사용과 대체 가능성은 같은 문제가 아니다

identity 함수는 값의 구체 타입을 몰라도 같은 값을 돌려준다.

```ts
function identity<T>(value: T): T {
  return value;
}
```

이것은 한 구현을 모든 T에 균일하게 쓰는 문제다. 반면 `format(value)`가 숫자·날짜·사용자 정의 타입마다 다른 구현을 고르는 것은 타입에 따라 연산을 선택하는 문제다. 또 `Dog`를 `Animal` 자리에 넣어도 되는지는 기존 계약의 모든 사용을 Dog가 감당하는지 묻는 대체 가능성 문제다. 세 가지를 모두 "다형성"이라고 부를 수 있지만 규칙과 실패 방식이 다르다.

## 핵심 개념

### 매개변수 다형성과 애드혹 다형성

**매개변수 다형성**(parametric polymorphism)은 타입을 매개변수로 받아 한 구현을 균일하게 적용한다. `identity<T>(T): T`, `map<A,B>((A)->B, List<A>): List<B>`가 대표다. 구현은 임의의 T 내부를 알 수 없으므로 할 수 있는 일이 제한된다. 이 제한이 강력한 추론을 준다. side effect와 bottom 같은 경계를 제외하면 `∀T. T -> T` 함수는 받은 값을 돌려주는 것 외에 거의 선택지가 없다.

**애드혹 다형성**(ad-hoc polymorphism)은 타입별 구현을 고른다. 함수 overload, operator overloading, typeclass·trait dispatch가 여기에 속한다.

```text
parametric: choose<T>(left: T, right: T): T  // 모든 T에 같은 구현
ad-hoc:     add(Number, Number), add(String, String) // 타입에 따라 구현 선택
```

매개변수 다형성은 재사용과 강한 관계 추론을 얻지만 타입별 연산을 직접 쓸 수 없다. 애드혹 다형성은 도메인별 동작을 표현하지만 후보 탐색, coherence, 모호한 overload, 오류 메시지 비용이 생긴다. Rust trait나 Haskell typeclass가 해결하는 문제는 "generic 문법" 자체보다 **타입별 연산 선택의 계약과 일관성**이다.

### 명목적 타입과 구조적 타입 — 관계의 증거가 다르다

명목적 타이핑(nominal typing)은 선언된 이름과 관계를 호환성의 근거로 삼는다.

```java
interface UserId { /* ... */ }
final class ExternalId { /* 같은 필드여도 UserId가 아님 */ }
```

Java·Kotlin의 class/interface 관계는 `extends`/`implements` 같은 명시 선언이 증거다. 우연히 필드가 같아도 다른 타입이므로 도메인 경계를 보존하고 API 진화 의도를 찾기 쉽다. 대신 기존 타입을 수정할 수 없거나 간단한 adapter가 필요한 상황에서 ceremony가 늘어난다.

구조적 타이핑(structural typing)은 필요한 member의 모양이 있으면 호환된다고 본다.

```ts
type Named = { name: string };
const service = { name: "billing", region: "ap-northeast-2" };
const named: Named = service; // 필요한 name이 있으므로 호환
```

TypeScript는 JavaScript의 익명 객체·함수 관습에 맞춰 구조적 호환성을 중심에 둔다. adapter 없이 조합하기 쉽지만 `UserId`와 `OrderId`가 같은 구조면 의도치 않게 섞일 수 있다. branded field나 opaque constructor는 구조적 시스템 안에 선택적인 nominal evidence를 되돌린다.

구조적 타입과 duck typing도 동일하지 않다. 둘 다 "지원하는 연산"을 본다는 직관은 같지만 TypeScript는 실행 전 구조를 비교하고, 전통적인 duck typing은 실행 중 member access가 실패할 수 있다. 검사 시점과 실패 계약이 다르다.

### 레코드 서브타이핑 — 폭과 깊이

`S <: T`는 S가 T의 subtype이며 T가 요구되는 모든 위치에 S 값을 넣을 수 있다는 뜻이다. 읽기 전용 레코드에서는 두 방향이 자연스럽다.

```text
Employee = { name: String, employeeId: Number }
Person   = { name: String }

Employee <: Person                    // 폭(width): 더 많은 필드
{ p: Employee } <: { p: Person }      // 깊이(depth): 읽는 필드 타입도 subtype
```

Person 소비자는 `name`만 읽으므로 추가 `employeeId`는 해가 없다. nested field `p`도 읽기만 한다면 더 구체적인 Employee를 Person처럼 읽을 수 있다.

mutable field에서는 깊이 공변성이 깨진다.

```text
box: { mutable value: Employee }
box를 { mutable value: Person }으로 취급
box.value = { name: "guest" }       // Person이지만 Employee는 아님
employeeId 읽기                     // 계약 파괴
```

같은 field에서 값을 읽고 쓰면 타입 매개변수는 producer이자 consumer다. 안전한 일반 규칙은 불변(invariant)이다. 읽기 전용 view를 분리하면 공변성을, 쓰기 전용 sink를 분리하면 반공변성을 회복할 수 있다.

### 함수 타입 — 입력은 반대로, 출력은 같은 방향으로

`Cat <: Animal`이라고 하자. 다음 두 함수 중 어떤 것이 `Cat -> Animal` 자리를 대신할 수 있는가?

```text
handleAny: Animal -> Cat
handleCat: Cat -> Animal
```

요구 계약 `Cat -> Animal`의 호출자는 Cat을 넘기고 Animal을 받을 권리가 있다. `handleAny`는 모든 Animal을 받을 수 있으므로 Cat도 받고, Cat을 반환하므로 Animal 요구도 만족한다. 안전하다.

일반 규칙은 다음이다.

```text
S₂ <: S₁   그리고   T₁ <: T₂
--------------------------------
(S₁ -> T₁) <: (S₂ -> T₂)
```

함수의 parameter는 **반공변**(contravariant), return은 **공변**(covariant)이다. 대입 방향을 외우기보다 권리를 추적한다.

- 구현은 호출자가 줄 수 있는 입력을 적어도 모두 받아야 한다. 더 좁은 입력만 받는 함수는 대체할 수 없다.
- 구현의 출력은 호출자가 기대한 것보다 같거나 더 구체적이어야 한다. 더 넓은 결과는 필요한 속성을 잃는다.

callback API에서 parameter 공변성을 허용하면 `Animal`을 전달할 수 있는 호출자가 Dog 전용 callback을 받고 Cat을 넘기는 반례가 생긴다. 이것이 함수 parameter를 반공변으로 검사해야 하는 이유다.

### generic variance — 생산자와 소비자로 판정한다

`Cat <: Animal`일 때 type constructor `F`가 관계를 어떻게 운반하는지를 variance라 한다.

| 사용 방식 | 안전한 관계 | 변성 | 예 |
|---|---|---|---|
| T를 반환만 함 | `F<Cat> <: F<Animal>` | 공변 | `Producer<out T>`, read-only collection |
| T를 입력으로만 받음 | `F<Animal> <: F<Cat>` | 반공변 | `Consumer<in T>`, callback sink |
| T를 읽고 씀 | 관계 없음 | 불변 | mutable cell, mutable array |

"PECS: Producer Extends, Consumer Super"는 Java wildcard의 기억법이지만 원리는 언어와 무관하다. 값의 흐름을 그리면 된다. API가 `T get()`만 제공하면 더 구체적인 값 생산자를 넓은 타입 생산자로 볼 수 있다. `put(T)`만 제공하면 Animal을 모두 받는 소비자는 Cat도 받을 수 있다. 둘 다 있으면 어느 한 방향도 안전하지 않다.

### 가변 배열 공변성의 반례

일부 명목 언어의 배열은 역사적으로 공변이다. 다음 흐름을 허용하면 정적 안전성을 유지하려고 store 시점 런타임 검사가 필요하다.

```java
Cat[] cats = new Cat[1];
Animal[] animals = cats; // 배열 공변
animals[0] = new Dog();  // 런타임 ArrayStoreException
```

`animals` 관점에서 Dog 쓰기는 합법이지만 실제 저장소는 Cat 배열이다. generic mutable collection이 대체로 불변인 이유다. 편리함을 위해 공변성을 허용하면 실패가 compile time에서 runtime으로 이동한다.

## 실무 관점: 실제 언어는 일반 규칙을 어떻게 적용하고 완화하는가

### TypeScript — 구조적 호환성과 의도적 비건전성

TypeScript의 호환성은 member 구조를 재귀 비교한다. JavaScript 생태계와 쉽게 연결되는 대신 공식 문서도 일부 연산이 compile time에 안전하다고 확정할 수 없는데 허용되는, 즉 비건전한 지점이 있음을 명시한다.

```ts
interface Animal { name: string }
interface Dog extends Animal { bark(): void }

function register(handler: (animal: Animal) => void) {}
register((dog: Dog) => dog.bark());
```

`strictFunctionTypes`는 일반 function type의 parameter를 더 엄격하게 반공변으로 검사한다. 다만 method·constructor에서 비롯된 선언은 호환성과 기존 generic class 관계를 위해 예외가 남는다. `any`, type assertion, unchecked indexed access도 증명 책임을 개발자에게 옮긴다. 따라서 "TypeScript 타입을 통과했다"를 입력 검증으로 간주하지 말고 외부 JSON은 `unknown`에서 runtime validation을 거쳐 도메인 타입으로 바꿔야 한다.

### Java/Kotlin — 명목 관계와 선언/사용 지점 변성

Java generic은 기본 불변이고 `? extends T` / `? super T`라는 사용 지점 wildcard로 읽기·쓰기 능력을 제한한다. Kotlin은 `Source<out T>`, `Comparable<in T>` 같은 선언 지점 변성을 제공하고 `Array<out T>`, `Array<in T>` type projection으로 사용 지점에서도 능력을 제한한다.

```kotlin
interface Source<out T> { fun next(): T }
interface Sink<in T> { fun accept(value: T) }
```

`out T`는 member의 출력 위치에만 T를 쓰게 제한하는 대가로 `Source<Cat> <: Source<Animal>`을 얻는다. `in T`는 입력 위치만 허용하고 반대 subtype 관계를 얻는다. mutable `Array<T>`는 get과 set을 모두 제공하므로 불변이며 projection을 통해 한쪽 능력을 가려야 한다.

### Rust — trait 계약, 소유권, lifetime subtyping

Rust trait는 구현이 제공할 연산을 명시하는 애드혹 다형성의 계약이고 generic monomorphization 또는 trait object dispatch로 사용된다. Rust의 일반 type subtyping은 class hierarchy가 아니라 주로 lifetime과 higher-ranked lifetime에 제한된다. `'static` reference를 더 짧은 lifetime이 필요한 곳에 쓸 수 있는 것은 더 오래 유효한 값이 더 짧은 요구를 만족하기 때문이다.

Rust Reference의 variance 표는 같은 생산자/소비자 원리를 더 엄격한 aliasing 모델에 적용한다. `&'a T`는 T에 공변이지만 `&'a mut T`는 T에 불변이다. mutable borrow가 읽기와 쓰기를 모두 허용하기 때문이다. 소유권은 단순한 메모리 해제 기법을 넘어 aliasing과 mutation의 허용 상태를 타입 검사에 포함한다. 그 효과와 비용은 챕터 6에서 더 다룬다.

### API 설계 절차

generic API의 variance를 결정할 때 declaration 키워드부터 고르지 않는다.

1. 호출자가 T를 넣는 모든 위치와 꺼내는 모든 위치를 표시한다.
2. callback 안쪽까지 부호를 뒤집어 추적한다. 함수 parameter를 지날 때 방향이 반전된다.
3. mutable state나 alias가 있으면 읽기·쓰기가 같은 저장소에 닿는지 확인한다.
4. producer view와 consumer view를 분리할 수 있는지 본다.
5. 실제 언어가 sound rule을 완화하는 지점과 runtime check를 명시한다.

추상화가 지나치면 작은 변경이 거대한 추론 오류로 번진다. 도메인에서 실제로 필요한 대체 관계만 공개하고, mutation 경계는 invariant하게 유지하며, public API에는 추론된 우연한 구조보다 이름 있는 계약을 두는 것이 진화 비용을 낮춘다.

## 더 깊이: 대체 가능성은 타입 모양보다 행동 계약이 넓다

타입상 subtype이어도 precondition을 강화하거나 postcondition을 약화하면 행동 대체 가능성을 깨뜨린다. `Square`를 mutable `Rectangle`의 subtype으로 두고 width만 바꾸는 method를 상속하면 "height는 유지된다"는 Rectangle 계약을 위반할 수 있다. 타입 시스템의 함수 반공변·공변 규칙은 계약의 일부를 구조적으로 검사하지만 성능, effect, 예외, 상태 불변식까지 자동으로 증명하지 않는다.

따라서 interface 대체를 검토할 때 타입 호환성 뒤에 다음을 확인한다.

- 입력 precondition을 더 강하게 요구하지 않는가?
- 반환 postcondition과 상태 invariant를 약화하지 않는가?
- 새 exception·blocking·I/O effect가 호출자 가정을 깨지 않는가?
- 구조적으로 우연히 호환된 타입이 같은 도메인 의미를 갖는가?

## 정리

- parametric polymorphism은 한 구현의 균일한 재사용, ad-hoc polymorphism은 타입별 연산 선택을 해결한다.
- nominal typing은 선언된 관계를, structural typing은 member 모양을 호환성 증거로 쓴다.
- 읽기 전용 레코드는 폭·깊이 공변성을 허용하지만 mutable field는 보통 불변이어야 한다.
- 함수 parameter는 반공변, return은 공변이다. 호출자의 입력·출력 권리를 보존하는 방향이다.
- producer는 공변, consumer는 반공변, 같은 저장소를 읽고 쓰는 container는 불변이 기본이다.

## 확인 문제

**1.** `Animal -> Dog` 함수를 `Dog -> Animal`이 필요한 곳에 제공해도 되는지 호출자 권리로 설명하라.

::: details 정답과 해설
가능하다. 요구 계약의 호출자는 Dog만 전달한다. 제공 함수는 모든 Animal을 받으므로 Dog도 안전하게 받는다. 요구 계약은 Animal을 반환받을 권리만 있는데 제공 함수는 더 구체적인 Dog를 반환한다. parameter는 더 넓게(반공변), return은 더 좁게(공변) 바뀌어 두 권리를 모두 보존한다.
:::

**2.** `MutableBox<Cat>`을 `MutableBox<Animal>`로 사용할 수 없지만 `ReadableBox<Cat>`은 `ReadableBox<Animal>`로 사용할 수 있는 이유를 반례로 보이라.

::: details 정답과 해설
MutableBox를 공변으로 허용하면 Animal view를 통해 Dog를 써 넣은 뒤 원래 Cat view에서 Cat으로 읽게 되어 계약이 깨진다. ReadableBox에는 write가 없으므로 이 반례가 없다. 꺼낸 Cat은 언제나 Animal이기도 해서 공변성이 안전하다. 능력을 줄여 subtype 관계를 얻은 사례다.
:::

**3.** 서로 다른 도메인의 `type UserId = { value: string }`, `type OrderId = { value: string }`가 TypeScript에서 섞였다. 구조적 타이핑을 버리지 않고 경계를 강화하는 방법과 비용을 설명하라.

::: details 정답과 해설
각 타입에 서로 다른 `unique symbol` brand를 넣고 검증된 constructor만 brand 값을 만들게 하거나 class의 private member로 nominal 성질을 만든다. 외부 입력은 runtime validation 후 constructor를 통과시킨다. 우연한 호환은 막지만 객체 생성·직렬화 경계의 변환 코드와 테스트가 늘고, brand를 type assertion으로 우회하면 증명 책임은 다시 호출자에게 간다.
:::

## 참고 자료

- Benjamin C. Pierce, *Types and Programming Languages* (2002), Ch. 15, 23–28 — 레코드·함수 서브타이핑과 polymorphism의 형식적 기준이다.
- TypeScript, [Type Compatibility](https://www.typescriptlang.org/docs/handbook/type-compatibility) — 구조적 호환성, 함수 비교, 의도적인 비건전성 지점을 공식 설명으로 확인한다.
- Kotlin, [Generics: in, out, where](https://kotlinlang.org/docs/generics.html) — 선언 지점 변성과 type projection을 producer/consumer 예제로 확인한다.
- Java Language Specification, [Subtyping](https://docs.oracle.com/javase/specs/jls/se24/html/jls-4.html#jls-4.10) — class·interface·array·generic type의 명목적 subtype 관계를 확인한다.
- Rust Reference, [Subtyping and variance](https://doc.rust-lang.org/reference/subtyping.html) — lifetime subtyping과 reference·function·interior mutability의 variance 표를 확인한다.
