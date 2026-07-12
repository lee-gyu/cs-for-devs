# 챕터 4 기획 — 언어 이론과 타입 시스템

[ROADMAP.md](../ROADMAP.md)의 챕터 4(`docs/ch-4/`, 인트로 1편과 본문 3편)를 집필하기 위한 상세 기획이다.
범위·경로가 ROADMAP과 어긋나면 ROADMAP을 우선한다.

## 1. 챕터의 관점

독자는 여러 프로그래밍 언어에서 스코프·클로저·제네릭·타입 추론을 사용하고 컴파일 오류를 해결해 온 5년차 이상 개발자다. 그러나 언어 기능을 개별 문법이나 키워드로 기억하면 같은 개념이 다른 언어에서 어떻게 달라지는지, 타입 검사가 어떤 오류를 배제하고 왜 일부 오류는 의도적으로 허용하는지 설명하기 어렵다.

이 챕터는 작은 언어의 **실행 가능한 규칙**을 공통 모델로 사용해 세 가지 판단 능력을 세운다.

1. **실행 의미 추적** — AST가 환경과 만나 어떤 값이 되는지 추적하고 스코프·클로저·평가 전략의 차이를 결과로 설명한다.
2. **타입 보장의 경계 판단** — 타입을 값과 연산의 정적 근사로 해석하고, 잘 타입된 프로그램이 배제하는 오류와 여전히 남는 실패를 구분한다.
3. **추상화 규칙 선택** — 다형성·서브타이핑·변성이 표현력을 늘리면서 타입 검사와 API 진화에 어떤 제약과 복잡성을 추가하는지 판단한다.

형식 표기 자체를 학습 목표로 삼지 않는다. 필요한 판단식은 의사 코드, 규칙 적용 표, 평가·추론 추적으로 풀어 쓰고 완전한 귀납 증명보다 반례와 관찰 가능한 실행 결과를 우선한다. TypeScript·Java/Kotlin·Rust는 공통 규칙의 적용과 완화 지점을 보여 주는 사례이지 챕터의 기준 모델이 아니다.

## 2. 범위 결정

### 다루는 것

- 구문과 실행 의미의 구분, AST와 환경, lexical scope, shadowing, 자유 변수와 바인딩 변수
- 클로저의 환경 캡처, strict/lazy 평가의 비용과 관찰 가능한 동작 차이
- 상태·제어·조합 관점에서 보는 명령형·객체지향·함수형 패러다임
- 정적·동적 타입과 강·약 타입이라는 서로 다른 분류 축
- 타입 환경과 타입 판단, 타입 오류의 정의, progress·preservation이 뜻하는 타입 안전성의 직관
- Hindley–Milner 계열의 타입 변수, 제약 생성, substitution, occurs check, 단일화, `let` 일반화와 인스턴스화
- parametric/ad-hoc polymorphism, nominal/structural typing
- 레코드의 폭·깊이 서브타이핑, 함수 인자의 반공변성과 반환값의 공변성, 가변 컨테이너의 불변성
- TypeScript의 구조적 타입과 의도적 비건전성, Java/Kotlin 계열의 명목적 타입과 선언/사용 지점 변성, Rust의 trait·소유권을 일반 모델의 경계 사례로 비교

### 위임하는 것

| 주제 | 위임 대상 | 챕터 4에서의 취급 |
|---|---|---|
| 논리의 구문·의미·건전성, Curry–Howard 대응 | ch-2 `01-mathematical-logic.md` | 타입 판단과 건전성에 필요한 공통 어휘만 이어받고 논리 체계는 반복하지 않는다 |
| 형식 언어·문법·오토마타 | ch-2 `02-formal-languages-and-automata.md` | 구문이 어떤 입력을 허용하는지와 의미가 무엇을 계산하는지만 구분한다 |
| 렉싱·파싱과 AST 생성 | ch-5 `01-lexing-and-parsing.md` | AST를 입력으로 가정하며 실습 parser는 starter로 제공한다 |
| 일반 데이터 흐름·추상 해석과 정적 분석 | ch-5 `04-static-analysis.md` | 타입 검사를 정적 분석의 한 사례로 연결하되 일반 분석 알고리즘은 위임한다 |
| 소유권의 메모리 관리 효과 | ch-6 `02-memory-management.md` | 선형·아핀 타입이 자원 사용을 제한한다는 연결만 제시하고 해제·할당 비용은 위임한다 |
| 결정 불가능성과 완벽한 분석기의 한계 | ch-2 `03-computability.md` | 모든 프로그램 성질을 완벽히 판정할 수 없는 이유를 연결하고 증명은 반복하지 않는다 |

### 다루지 않기로 결정한 것

- **람다 계산의 완전한 형식 전개와 타입 건전성 귀납 증명은 하지 않는다.** 판단식을 읽고 대표 프로그램에 적용할 수 있는 수준으로 제한한다.
- **고급 타입 시스템을 구현하지 않는다.** 효과·의존·선형·아핀·정제 타입은 기본 모델을 확장하는 지도와 사용 신호만 제시한다.
- **타입스크립트 사용법이나 산업 언어 기능 카탈로그를 만들지 않는다.** 실제 언어는 일반 규칙의 경계와 트레이드오프를 확인할 최소 사례로 제한한다.
- **서브타이핑과 Hindley–Milner 추론을 하나의 실습 언어에 결합하지 않는다.** 두 기능의 상호작용과 추론 복잡성이 핵심 학습 목표를 흐리기 때문이다.
- **모듈·매크로·메타프로그래밍·trait/typeclass 해석 알고리즘은 다루지 않는다.** 추상화 방식의 사례로 이름과 계약만 연결한다.

## 3. 문서별 상세 기획

본문 3편은 콘텐츠 집필 지침의 기본 구조(학습 목표 → 배경 → 핵심 개념 → 실무 관점 → 더 깊이 → 정리 → 확인 문제 → 참고 자료)를 따르고 45~90분 분량으로 작성한다. `00-introduction.md`는 10~15분 분량의 오리엔테이션으로 구성한다.

### `00-introduction.md` — 코드는 문법만 맞는다고 프로그램이 되지 않는다

- **핵심 질문**: 같은 표면 문법의 코드가 언어의 의미 규칙과 타입 계약에 따라 다른 동작과 오류를 만드는 이유는 무엇인가?
- 잘못된 변수 캡처와 타입 검사 통과 뒤의 런타임 실패를 도입 사례로 사용해 구문, 실행 의미, 정적 타입 판단을 서로 다른 층으로 분리한다.
- 언어 설계를 표현력·안전성·구현 및 학습 복잡성의 교환으로 보는 판단 지도를 제시한다.
- 실행 의미(01) → 타입 안전성과 추론(02) → 추상화와 대체 가능성(03)의 학습 흐름을 소개하고 세부 정의는 각 본문에 위임한다.

### `01-language-semantics.md` — AST는 어떻게 값이 되는가

- **핵심 질문**: 변수와 함수가 포함된 AST를 평가할 때 어떤 환경을 조회하고 어떤 시점의 값을 사용해야 하는가?
- **핵심 개념 뼈대**
  - 구문과 실행 의미: 같은 AST에 다른 평가 규칙을 부여할 수 있다는 구분
  - 환경 기반 big-step 평가: `evaluate(expression, environment) -> value`를 기준 인터페이스로 사용
  - lexical scope와 dynamic scope의 환경 선택 차이, shadowing과 이름 해석
  - 클로저를 함수 코드와 정의 시점 환경의 쌍으로 표현하는 이유
  - strict/call-by-value와 lazy/call-by-need 평가에서 실행 횟수·부작용·종료 여부가 달라지는 조건
  - mutation과 effect가 참조 투명성을 깨뜨리고 평가 순서를 관찰 가능하게 만드는 방식
  - 명령형·객체지향·함수형을 상태, 제어, 데이터와 동작의 조합 방식으로 비교
- **관찰 예제**: 같은 변수 이름을 안팎에서 shadowing하는 고차 함수를 lexical/dynamic scope 평가기로 각각 실행해 결과와 조회한 환경을 출력한다. 지연 평가 예제는 사용되지 않는 인자가 예외를 발생시키는 경우로 평가 전략의 차이를 확인한다.
- **경계 조건**: loop variable capture, mutable capture, 재귀 환경 구성, 비동기 실행에서 언어가 복원한 논리적 컨텍스트와 실제 호출 스택을 구분한다.

### `02-type-safety-and-inference.md` — 실행하지 않고 무엇을 배제할 수 있는가

- **핵심 질문**: 타입 검사기는 실행할 값이 아직 없는데 어떻게 허용할 연산을 판단하고, 그 판단은 무엇을 보장하는가?
- **핵심 개념 뼈대**
  - 정적/동적 타입 검사는 검사 시점, 강/약 타입은 암묵적 변환과 허용 연산 정책이라는 서로 다른 축
  - 타입을 가능한 값과 연산의 근사로 보고 타입 환경 `Γ`와 판단 `Γ ⊢ e : τ`를 읽는 방법
  - 리터럴, 변수, 산술, 조건식, 함수, 적용, `let`의 타입 규칙을 평가 규칙과 나란히 비교
  - progress와 preservation의 직관: 잘 타입된 닫힌 식이 값이거나 다음 단계로 진행하며, 진행 뒤에도 타입이 유지된다는 의미
  - 타입 안전성이 종료, 논리적 정답, I/O 성공, 메모리·시간 한도, 모든 예외 부재를 보장하지 않는 경계
  - 타입 변수와 동등성 제약 생성, substitution 합성, 단일화와 occurs check
  - `let` 경계의 일반화와 사용 지점 인스턴스화, principal type의 의미
- **공통 추적 예제**: `let id = fun x -> x in let ignored = id(1) in id(true)`를 AST → 제약 → 단일화 → 일반화 → 인스턴스화 → 최종 타입 순서로 추적한다. 최종 타입이 `Boolean`이 되고 같은 `id`가 앞선 숫자 호출과 독립적으로 인스턴스화되는 과정을 보인다.
- **경계 조건**: `fun x -> x x`의 무한 타입, 다형 재귀가 자동 추론 범위를 벗어나는 이유, mutation과 `let` 다형성이 결합할 때 필요한 value restriction을 확장 사례로 다룬다.

### `03-abstraction-and-subtyping.md` — 무엇을 같은 인터페이스로 대체할 수 있는가

- **핵심 질문**: 서로 다른 구현과 타입을 같은 추상화로 사용할 때 어떤 대체가 안전하며 누가 그 관계를 선언하거나 추론하는가?
- **핵심 개념 뼈대**
  - parametric polymorphism과 ad-hoc polymorphism이 구현 재사용과 연산 선택을 해결하는 서로 다른 방식
  - nominal typing과 structural typing에서 타입 동일성·호환성의 근거가 달라지는 지점
  - 레코드 폭·깊이 서브타이핑과 읽기 전용/가변 필드가 안전성 조건을 바꾸는 이유
  - 함수 타입에서 인자는 반공변, 반환값은 공변이어야 하는 이유를 호출자·구현자 계약으로 추적
  - 불변 컨테이너, 읽기 전용 생산자, 쓰기 전용 소비자의 변성 차이
  - 추상화가 표현력을 높이는 대신 오류 메시지, 추론 비용, API 진화와 학습 복잡성을 키우는 조건
- **실무 비교**: TypeScript의 구조적 호환성과 일부 비건전성, Java/Kotlin 제네릭 변성, Rust trait·소유권을 동일한 생산자/소비자 및 대체 가능성 질문으로 비교한다.
- **경계 조건**: 가변 배열 공변성의 런타임 실패, 과도한 구조적 호환이 의도하지 않은 결합을 만드는 경우, 타입 assertion·dynamic/unknown 경계가 정적 보장을 약화하는 방식을 다룬다.

## 4. 문서 간 의존 관계

```text
00 구문·실행 의미·타입 계약 지도
                │
                ▼
01 환경과 평가 규칙 ──▶ 02 같은 AST의 타입 규칙·안전성 ──▶ 03 대체 가능성과 추상화
         │                         │
         └── 환경 기반 평가기      └── HM 타입 추론기
                         \          /
                          통합 실습
```

- 01에서 고정한 AST, lexical environment, 값 모델을 02의 타입 환경과 나란히 놓아 동적 실행과 정적 판단의 책임을 비교한다.
- 02의 함수 타입과 다형성은 03의 함수 서브타이핑과 변성을 이해하는 전제지만, 03은 HM 실습에 서브타이핑을 추가하지 않는다.
- 공통 Toy 언어는 개념과 실습을 잇는 기준 모델이다. 각 문서는 필요한 AST와 규칙을 자체적으로 다시 제시해 이전 문서의 구현 완료를 읽기 전제로 삼지 않는다.
- ch-5 실습이 ch-4의 AST를 재사용할 수 있도록 리터럴·연산·조건식·변수·`let`이라는 공통 부분을 유지한다. 일급 함수와 클로저는 ch-4 전용 확장으로 두어 ch-5의 단순 함수 VM 구현을 강제하지 않는다.

## 5. 실습 과제 기획 (`exercises/ch-4/`)

ROADMAP 산출물은 “함수와 `let` 다형성을 지원하는 소형 표현식 언어의 환경 기반 평가기와 Hindley–Milner 타입 추론기를 구현하고, 추론 과정과 타입 보장의 경계를 분석한다”이다.

### 환경과 언어 범위

- **환경**: TypeScript + Node.js 24, `node:test`, `exercises/ch-4/` 아래 pnpm 워크스페이스 패키지. 외부 런타임 의존성은 두지 않는다.
- **식 문법**: 숫자·불리언 리터럴, `+ - * /`, `== < <=`, `if`, 변수, `fun parameter -> body`, 함수 적용, `let name = value in body`.
- **값**: JavaScript `number`·`boolean`과 `{ parameter, body, environment }` 형태의 closure.
- **타입**: `Number`, `Boolean`, 함수 타입, 추론 중 사용하는 타입 변수, 일반화된 타입 스킴.
- **명시적 제외**: 문자열, 튜플·레코드, 클래스·메서드, mutation, 재귀 바인딩, 예외, 서브타이핑, 사용자 정의 타입. 제네릭과 변성은 본문 판단 사례로만 다룬다.
- **파싱**: source span이 포함된 discriminated union AST와 starter parser를 제공한다. 학습자는 파서를 구현하지 않으며, 테스트에서는 AST builder를 직접 사용할 수 있다.

### 공개 인터페이스

```ts
type Span = { start: number; end: number };

type Expression =
  | { kind: "number"; value: number; span: Span }
  | { kind: "boolean"; value: boolean; span: Span }
  | { kind: "variable"; name: string; span: Span }
  | { kind: "binary"; operator: "+" | "-" | "*" | "/" | "==" | "<" | "<="; left: Expression; right: Expression; span: Span }
  | { kind: "if"; condition: Expression; then: Expression; otherwise: Expression; span: Span }
  | { kind: "function"; parameter: string; body: Expression; span: Span }
  | { kind: "call"; callee: Expression; argument: Expression; span: Span }
  | { kind: "let"; name: string; value: Expression; body: Expression; span: Span };

type Type =
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "variable"; id: number }
  | { kind: "function"; parameter: Type; result: Type };

type TypeScheme = { quantified: number[]; type: Type };

type Environment<T> = {
  bindings: ReadonlyMap<string, T>;
  parent?: Environment<T>;
};

type Closure = {
  parameter: string;
  body: Expression;
  environment: Environment<Value>;
};

type Value = number | boolean | Closure;
type ValueEnvironment = Environment<Value>;
type TypeEnvironment = Environment<TypeScheme>;

type TypeDiagnostic =
  | { kind: "UnboundVariable"; name: string; span: Span }
  | { kind: "TypeMismatch"; expected: Type; actual: Type; span: Span }
  | { kind: "NotCallable"; actual: Type; span: Span }
  | { kind: "InfiniteType"; variableId: number; type: Type; span: Span };

type InferTraceEvent =
  | { kind: "Constraint"; left: Type; right: Type; span: Span }
  | { kind: "Unify"; left: Type; right: Type; substitution: ReadonlyMap<number, Type> }
  | { kind: "Generalize"; name: string; scheme: TypeScheme; span: Span }
  | { kind: "Instantiate"; name: string; scheme: TypeScheme; type: Type; span: Span };

type InferResult =
  | { ok: true; type: Type; trace: InferTraceEvent[] }
  | { ok: false; error: TypeDiagnostic; trace: InferTraceEvent[] };

type EvaluationDiagnostic =
  | { kind: "UnboundVariable"; name: string; span: Span }
  | { kind: "InvalidOperand"; operator: string; span: Span }
  | { kind: "NotCallable"; span: Span }
  | { kind: "DivisionByZero"; span: Span };

evaluate(expression: Expression, environment?: ValueEnvironment):
  | { ok: true; value: Value }
  | { ok: false; error: EvaluationDiagnostic };
infer(expression: Expression, environment?: TypeEnvironment): InferResult;
formatType(type: Type): string;
```

- `InferResult`는 성공 시 substitution이 적용된 principal type과 추론 trace를, 실패 시 구조화된 `TypeDiagnostic`을 반환한다.
- 타입 오류 종류는 `UnboundVariable`, `TypeMismatch`, `NotCallable`, `InfiniteType`으로 고정하고 source span, 기대 타입, 실제 타입 또는 관련 타입 변수를 포함한다.
- 평가기는 예외를 던지지 않고 `EvaluationDiagnostic`을 포함한 결과를 반환한다. 타입 검사를 건너뛴 AST도 독립적으로 진단할 수 있게 한다.
- 타입 출력은 타입 변수 ID를 첫 등장 순서대로 `'a`, `'b`로 정규화해 테스트와 리포트가 실행 순서에 흔들리지 않게 한다.
- 0으로 나누기는 타입 오류가 아니며 평가 시 `DivisionByZero` 진단으로 처리한다. 이를 정적 타입 안전성과 전체 런타임 성공의 차이를 보여 주는 기준 사례로 사용한다.

### 구현 단계

1. lexical environment chain과 closure를 사용하는 환경 기반 평가기를 구현한다.
2. AST 노드마다 새 타입 변수를 배정하고 타입 동등성 제약을 생성한다.
3. substitution 적용·합성과 occurs check를 포함한 단일화를 구현한다.
4. 함수 매개변수는 단일형으로 환경에 넣고, `let` 값은 현재 환경에 자유롭지 않은 타입 변수만 일반화한다.
5. 다형적 타입 스킴을 조회할 때 quantified variable마다 새 타입 변수를 생성해 인스턴스화한다.
6. 규칙 적용, 생성 제약, 단일화, 일반화·인스턴스화 이벤트를 결정적인 trace로 기록한다.

### 검증 시나리오

- 평가: 산술·비교, 조건식 양쪽, lexical shadowing, closure capture, 고차 함수와 연쇄 호출
- 기본 추론: 리터럴, 산술·비교, 조건식, identity·constant·composition 함수
- `let` 다형성: 같은 `id`를 숫자와 불리언에 각각 적용해 독립적으로 인스턴스화되는지 확인
- 오류: 미정의 변수, 불리언에 산술 적용, 조건식 분기 타입 불일치, 함수가 아닌 값 호출
- occurs check: `fun x -> x x`가 `InfiniteType`으로 거부되는지 확인
- shadowing: 같은 이름의 외부 타입 스킴이 내부 바인딩에 새어 들어오지 않는지 확인
- 결정성: 동일 AST의 `formatType`과 추론 trace가 반복 실행에서 동일한지 확인
- property-style 검사: 제한된 깊이의 well-typed AST를 고정 seed로 생성해 `infer`가 성공하고, 정의된 타입 오류 없이 `evaluate`되는지 확인한다. 0으로 나누기와 비종료가 없는 생성 문법으로 제한한다.

### 완료 기준

- 모든 단위·통합·property-style 테스트가 한 명령으로 통과한다.
- 평가기와 추론기의 공개 타입 및 오류 계약이 README에 설명되어 있다.
- 최소 세 프로그램에 대해 `AST → 제약 → 단일화 → 일반화/인스턴스화 → 최종 타입` 추적표를 제시한다.
- 리포트가 타입 시스템이 배제한 오류와 종료·외부 I/O·자원 고갈·논리 오류처럼 보장하지 않는 성질을 구분한다.
- ch-5가 공통 AST 부분을 재사용할 수 있는 지점과 일급 함수 등 재사용하지 않는 확장을 명시한다.

## 6. 조사 노트 — 1차 자료 후보

집필 시 원 논문과 각 언어의 공식 명세·문서를 우선하고, 구현 및 버전에 의존하는 동작은 인용 시점에 다시 검증한다.

- **의미론과 타입 시스템**: Benjamin C. Pierce, *Types and Programming Languages* — operational semantics, 타입 안전성, 서브타이핑의 기준 모델
- **다형적 타입 추론**: Robin Milner, “A Theory of Type Polymorphism in Programming”; Luis Damas와 Robin Milner, “Principal Type-Schemes for Functional Programs” — `let` 다형성과 principal type의 원전
- **타입 추론 알고리즘**: Hindley–Milner 및 Algorithm W의 표준 문헌. 본문과 실습은 구현하기 쉬운 제약 생성+단일화 표현을 쓰고 Algorithm W와의 관계를 밝힌다.
- **TypeScript**: TypeScript Handbook과 언어 설계 문서의 type compatibility, soundness, variance 설명
- **Java/Kotlin**: Java Language Specification의 subtyping·generic type, Kotlin 공식 문서의 declaration-site variance와 type projections
- **Rust**: The Rust Reference와 Rust 공식 Book의 trait, ownership, subtyping·variance 관련 공식 자료

### 통념 검증 목록

- “정적 타입 언어는 강타입이고 동적 타입 언어는 약타입이다” → 검사 시점과 허용 변환 정책은 서로 다른 축이다.
- “타입 검사를 통과하면 프로그램은 안전하다” → 어떤 오류를 배제하는지는 언어의 타입 안전성 정의에 달렸고 종료·자원·I/O·논리 정답은 별도 성질이다.
- “타입 추론은 값의 타입을 실행 중 알아내는 동적 타이핑이다” → 타입 추론은 실행 전 제약을 풀어 정적 타입을 도출한다.
- “구조적 타입은 duck typing과 같다” → 필요한 구조로 호환성을 판단한다는 유사점은 있지만 검사 시점과 실패 계약이 다르다.
- “하위 타입의 컨테이너는 항상 상위 타입 컨테이너의 하위 타입이다” → 가변 쓰기가 허용되면 안전하지 않아 불변성이 필요하다.
- “함수 인자도 반환값처럼 공변이면 자연스럽다” → 호출자가 제공할 수 있는 입력 집합을 좁혀 대체 가능성을 깨뜨린다.
- “건전한 타입 시스템은 모든 안전한 프로그램을 받아들인다” → 건전성을 높이면 실제로 안전한 일부 프로그램을 거부할 수 있으며 완전성과 표현력 비용이 생긴다.

## 7. 작성 순서와 검증 계획

1. Toy 언어의 AST, 값, 환경, 타입, 오류 계약을 먼저 고정한 뒤 네 문서의 예제와 실습에서 같은 의미를 사용한다.
2. `00 → 01 → 02 → 03` 순서로 집필한다. 01의 평가 추적을 테스트로 검증한 뒤 동일 AST를 02의 타입 추론 예제로 사용한다.
3. 02 집필 전에 실습 추론기의 제약·단일화·일반화 trace를 구현해 본문 표의 중간 결과가 실제 출력과 일치하게 한다.
4. 03의 산업 언어 사례는 현재 공식 명세와 최소 재현 코드로 확인하고 일반 모델, 표준 보장, 특정 구현의 완화를 구분한다.
5. 각 문서의 확인 문제는 실행 결과 예측, 잘못된 타입 규칙의 반례, 추론 trace 완성, 안전한 변성 선택처럼 규칙 적용과 판단을 요구한다.
6. `docs/ch-4/`을 만들 때 `docs/.vitepress/navigation.ts`의 챕터 4 레이블과 4편 순서를 확인하고 `pnpm docs:build`로 nav/sidebar 및 내부 링크를 검증한다.
7. 본문·실습 작성 전까지 `PROGRESS.md`의 상태는 예정으로 유지한다. 문서 수는 ROADMAP의 4편 구성과 일치시킨다.
8. 완료 전 ROADMAP, PROGRESS, 실제 파일, ch-2·ch-5·ch-6의 위임 경로를 대조하고 `git diff --check`를 실행한다.
