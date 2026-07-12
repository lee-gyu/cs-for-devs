import assert from "node:assert/strict";
import test from "node:test";
import { evaluate, formatType, infer, parse, type Expression } from "../src/index.ts";

function succeeds(source: string, expectedType: string, expectedValue?: number | boolean) {
  const ast = parse(source), inferred = infer(ast), evaluated = evaluate(ast);
  assert.equal(inferred.ok, true, inferred.ok ? "" : inferred.error.kind);
  if (inferred.ok) assert.equal(formatType(inferred.type), expectedType);
  assert.equal(evaluated.ok, true, evaluated.ok ? "" : evaluated.error.kind);
  if (expectedValue !== undefined && evaluated.ok) assert.equal(evaluated.value, expectedValue);
}

test("산술·비교·조건식을 평가하고 추론한다", () => {
  succeeds("if 1 + 2 * 3 <= 7 then 10 else 20", "Number", 10);
  succeeds("3 == 3", "Boolean", true);
});

test("lexical closure는 호출 위치가 아니라 정의 위치 환경을 캡처한다", () => {
  succeeds("let x = 10 in let addX = fun y -> x + y in let x = 100 in addX(5)", "Number", 15);
  succeeds("let apply = fun f -> fun x -> f(x) in apply(fun n -> n * 2)(4)", "Number", 8);
});

test("let 다형성은 id 사용마다 독립적으로 인스턴스화한다", () => {
  const result = infer(parse("let id = fun x -> x in let ignored = id(1) in id(true)"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(formatType(result.type), "Boolean");
  assert.equal(result.trace.filter((event) => event.kind === "Instantiate" && event.name === "id").length, 2);
  assert.equal(result.trace.some((event) => event.kind === "Generalize" && event.name === "id"), true);
});

test("identity·constant·composition의 principal type을 구한다", () => {
  const cases = [
    ["fun x -> x", "'a -> 'a"],
    ["fun x -> fun y -> x", "'a -> 'b -> 'a"],
    ["fun f -> fun g -> fun x -> f(g(x))", "('a -> 'b) -> ('c -> 'a) -> 'c -> 'b"],
  ] as const;
  for (const [source, expected] of cases) {
    const result = infer(parse(source));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(formatType(result.type), expected);
  }
});

test("구조화된 정적 오류를 반환한다", () => {
  const cases = [
    ["missing", "UnboundVariable"],
    ["true + 1", "TypeMismatch"],
    ["if true then 1 else false", "TypeMismatch"],
    ["1(true)", "NotCallable"],
    ["fun x -> x(x)", "InfiniteType"],
  ] as const;
  for (const [source, kind] of cases) {
    const result = infer(parse(source));
    assert.equal(result.ok, false, source);
    if (!result.ok) assert.equal(result.error.kind, kind, source);
  }
});

test("타입 클래스 없는 ==는 숫자에 제한해 closure 비교가 well-typed가 되지 않게 한다", () => {
  const result = infer(parse("fun x -> x == x"));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(formatType(result.type), "Number -> Boolean");
  assert.equal(infer(parse("(fun x -> x) == (fun y -> y)")).ok, false);
});

test("타입 검사를 통과해도 0 나누기는 실행 진단이 된다", () => {
  const ast = parse("10 / 0");
  assert.equal(infer(ast).ok, true);
  const result = evaluate(ast);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "DivisionByZero");
});

test("shadowing은 가장 가까운 값과 타입 바인딩을 선택한다", () => {
  succeeds("let x = true in let x = 41 in x + 1", "Number", 42);
});

test("타입 출력과 trace는 반복 실행에서 결정적이다", () => {
  const ast = parse("let id = fun x -> x in id(id(1))");
  const snapshots = Array.from({ length: 3 }, () => {
    const result = infer(ast);
    assert.equal(result.ok, true);
    return JSON.stringify(result, (_key, value) => value instanceof Map ? [...value] : value);
  });
  assert.equal(new Set(snapshots).size, 1);
});

test("고정 seed로 만든 well-typed AST는 추론과 평가에 성공한다", () => {
  let seed = 0x5eed1234;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  const span = { start: 0, end: 0 };
  const numberExpression = (depth: number): Expression => {
    if (depth === 0 || random() % 3 === 0) return { kind: "number", value: random() % 100 + 1, span };
    const left = numberExpression(depth - 1), right = numberExpression(depth - 1);
    return { kind: "binary", operator: ["+", "-", "*"][random() % 3] as "+" | "-" | "*", left, right, span };
  };
  for (let index = 0; index < 100; index++) {
    const ast = numberExpression(4);
    assert.equal(infer(ast).ok, true);
    assert.equal(evaluate(ast).ok, true);
  }
});
