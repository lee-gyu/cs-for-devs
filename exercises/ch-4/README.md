# 챕터 4 실습 — 환경 기반 평가기와 Hindley–Milner 타입 추론기

[ROADMAP](../../ROADMAP.md)과 [챕터 4 기획](../../plan/ch-4.md)의 산출물을 실행 가능한 기준 구현으로 제공한다. 숫자·불리언·함수·호출·`let`이 있는 작은 표현식 언어에서 **동적 실행과 정적 판단을 같은 AST 위에 나란히 구현**하고, 타입 시스템이 막는 실패와 막지 않는 실패를 분석한다.

## 학습 목표

- lexical environment chain과 closure로 이름 해석과 함수 호출을 구현한다.
- AST에서 타입 동등성 제약을 만들고 substitution·occurs check를 포함해 단일화한다.
- `let` 바인딩을 일반화하고 각 사용 지점에서 타입 스킴을 새로 인스턴스화한다.
- 추론 trace와 실행 결과를 근거로 정적 보장의 범위를 설명한다.

## 환경과 실행

- Node.js 24 이상. 외부 런타임 의존성은 없다.
- 테스트는 `node:test`, TypeScript 실행은 Node의 type stripping을 사용한다.

```bash
cd exercises/ch-4
pnpm test
pnpm demo
```

`src/parser.ts`는 starter parser다. 파서 구현은 과제 범위가 아니며 테스트에서 `parse()` 또는 직접 만든 discriminated union AST를 사용할 수 있다. 모든 span은 소스의 UTF-16 offset 기준 `[start, end)`이다.

## 언어와 공개 계약

문법의 요지는 다음과 같다. 함수 호출은 괄호 한 인자 형식이고 `f(a)(b)`로 curried 함수를 연쇄 호출한다. 타입 클래스나 overload를 넣지 않은 기준 타입 시스템에서 `==`, `<`, `<=`의 피연산자는 숫자로 제한한다. 평가기는 타입 검사를 건너뛴 AST도 독립 진단하기 위해 같은 종류의 불리언끼리 `==`도 실행할 수 있지만, 그 AST는 기준 타입 검사에서 거부된다.

```text
expression := NUMBER | true | false | NAME
            | expression OP expression
            | if expression then expression else expression
            | fun NAME -> expression
            | expression(expression)
            | let NAME = expression in expression
```

공개 타입은 `src/language.ts`, 함수 export는 `src/index.ts`가 소유한다.

```ts
evaluate(expression, valueEnvironment?)
  // { ok: true, value } | { ok: false, error: EvaluationDiagnostic }

infer(expression, typeEnvironment?)
  // { ok: true, type, trace } | { ok: false, error: TypeDiagnostic, trace }

formatType(type) // Number, Boolean, 'a -> 'a
```

평가 오류는 `UnboundVariable`, `InvalidOperand`, `NotCallable`, `DivisionByZero`이고 타입 오류는 `UnboundVariable`, `TypeMismatch`, `NotCallable`, `InfiniteType`이다. API는 예상 가능한 사용자 프로그램 오류에 예외를 던지지 않는다. `formatType`은 내부 변수 ID와 무관하게 첫 등장 순서로 `'a`, `'b`를 붙인다.

## 구현 과제

기준 구현을 먼저 테스트한 뒤 함수 내부를 TODO로 바꾸어 아래 순서로 복원한다.

1. `Environment<T>`의 parent chain을 따라 가장 가까운 바인딩을 찾는다.
2. 함수 값을 `{ parameter, body, environment }` closure로 만들고 호출할 때 **closure 환경**을 확장한다.
3. 함수 매개변수에 새 타입 변수를 주고 호출에서 `callee ~ argument -> result` 제약을 만든다.
4. 단일화 전에 현재 substitution을 재귀 적용하고, 변수를 타입에 묶기 전에 occurs check를 한다.
5. `let` 값에서 현재 환경에 자유롭지 않은 타입 변수만 일반화한다. 변수 조회마다 quantified 변수를 fresh variable로 교체한다.
6. 같은 AST를 두 번 추론해 출력과 trace가 동일한지 확인한다.

## 추론 추적표

trace의 `Constraint`, `Unify`, `Generalize`, `Instantiate` 이벤트로 다음 세 프로그램을 재현한다. 내부 ID는 달라도 `formatType` 결과와 관계는 같아야 한다.

| 프로그램 / AST 핵심 모양 | 생성 제약 | 단일화 | 일반화/인스턴스화 | 최종 타입 |
|---|---|---|---|---|
| `fun x -> x` / `Function(x, Variable(x))` | 매개변수와 조회가 같은 `'a` | 추가 substitution 없음 | `let`이 없어 없음 | `'a -> 'a` |
| `let id = fun x -> x in let ignored = id(1) in id(true)` / `Let(id, Function, Let(ignored, Call, Call))` | 첫 호출 `'b -> 'b ~ Number -> 'c`; 둘째 호출 `'d -> 'd ~ Boolean -> 'e` | `'b,'c ↦ Number`; `'d,'e ↦ Boolean` | `id : ∀a. a -> a`; 두 조회에서 `'b`, `'d`로 독립 인스턴스화 | `Boolean` |
| `fun x -> x(x)` / `Function(x, Call(Variable(x), Variable(x)))` | `'a ~ 'a -> 'b` | `'a`를 포함한 타입에 `'a`를 묶으려다 occurs check 실패 | `let` 경계에 도달하지 않아 없음 | `InfiniteType` |

`pnpm demo`는 이 세 사례의 실제 trace를 출력한다. 두 번째 프로그램에서 `id`의 `Instantiate`가 두 번이고, 두 substitution이 독립적인지 확인한다.

## 보장의 경계 리포트

완료 보고서에는 적어도 다음 구분을 자신의 테스트와 함께 기록한다.

| 타입 시스템이 배제하는 것 | 이 언어에서 여전히 남는 것 |
|---|---|
| 불리언 산술, 비불리언 조건, 분기 타입 불일치, 숫자를 함수처럼 호출, 미정의 이름, 무한 타입 | `10 / 0`, 종료 여부(재귀를 추가한다면), 논리적으로 틀린 공식, 입력·네트워크 실패(효과를 추가한다면), 시간·메모리 고갈 |

`10 / 0`은 `Number`로 추론되지만 실행은 `DivisionByZero`다. 이것은 타입 안전성의 실패가 아니다. 현재 타입 규칙은 0이 아닌 수를 표현하지 않으므로 0 나누기를 배제하겠다고 약속한 적이 없다. 정제 타입이나 효과 타입은 이 경계를 옮길 수 있지만 복잡성과 주석·추론 비용이 추가된다.

## 챕터 5와의 재사용 경계

`Span`, 리터럴, 변수, binary, `if`, `let` AST는 챕터 5의 parser·IR·VM 실습이 재사용할 수 있다. `function`, `call`, closure environment, HM type scheme은 챕터 4의 일급 함수 확장이다. 챕터 5 VM이 단순한 이름 기반 함수 호출만 구현한다면 이 확장을 억지로 재사용하지 않는다. 특히 HM 추론과 서브타이핑은 이 실습에서 결합하지 않는다.

## 완료 기준

- [ ] `pnpm test`에서 평가·추론·오류·occurs check·shadowing·결정성·고정 seed 생성 검사가 모두 통과한다.
- [ ] 최소 세 프로그램의 trace를 표로 설명하고 실제 이벤트와 대조했다.
- [ ] 타입 시스템이 배제한 오류와 보장하지 않은 성질을 별도 열로 기록했다.
- [ ] 공개 타입·오류 계약과 챕터 5 재사용 경계를 설명할 수 있다.
