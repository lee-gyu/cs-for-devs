export type Span = { start: number; end: number };

export type BinaryOperator = "+" | "-" | "*" | "/" | "==" | "<" | "<=";

export type Expression =
  | { kind: "number"; value: number; span: Span }
  | { kind: "boolean"; value: boolean; span: Span }
  | { kind: "variable"; name: string; span: Span }
  | { kind: "binary"; operator: BinaryOperator; left: Expression; right: Expression; span: Span }
  | { kind: "if"; condition: Expression; then: Expression; otherwise: Expression; span: Span }
  | { kind: "function"; parameter: string; body: Expression; span: Span }
  | { kind: "call"; callee: Expression; argument: Expression; span: Span }
  | { kind: "let"; name: string; value: Expression; body: Expression; span: Span };

export type Type =
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "variable"; id: number }
  | { kind: "function"; parameter: Type; result: Type };

export type TypeScheme = { quantified: number[]; type: Type };

export type Environment<T> = {
  bindings: ReadonlyMap<string, T>;
  parent?: Environment<T>;
};

export type Closure = {
  parameter: string;
  body: Expression;
  environment: Environment<Value>;
};

export type Value = number | boolean | Closure;
export type ValueEnvironment = Environment<Value>;
export type TypeEnvironment = Environment<TypeScheme>;

export type TypeDiagnostic =
  | { kind: "UnboundVariable"; name: string; span: Span }
  | { kind: "TypeMismatch"; expected: Type; actual: Type; span: Span }
  | { kind: "NotCallable"; actual: Type; span: Span }
  | { kind: "InfiniteType"; variableId: number; type: Type; span: Span };

export type InferTraceEvent =
  | { kind: "Constraint"; left: Type; right: Type; span: Span }
  | { kind: "Unify"; left: Type; right: Type; substitution: ReadonlyMap<number, Type> }
  | { kind: "Generalize"; name: string; scheme: TypeScheme; span: Span }
  | { kind: "Instantiate"; name: string; scheme: TypeScheme; type: Type; span: Span };

export type InferResult =
  | { ok: true; type: Type; trace: InferTraceEvent[] }
  | { ok: false; error: TypeDiagnostic; trace: InferTraceEvent[] };

export type EvaluationDiagnostic =
  | { kind: "UnboundVariable"; name: string; span: Span }
  | { kind: "InvalidOperand"; operator: string; span: Span }
  | { kind: "NotCallable"; span: Span }
  | { kind: "DivisionByZero"; span: Span };

export type EvaluationResult =
  | { ok: true; value: Value }
  | { ok: false; error: EvaluationDiagnostic };

export const NUMBER: Type = { kind: "number" };
export const BOOLEAN: Type = { kind: "boolean" };
export const EMPTY_SPAN: Span = { start: 0, end: 0 };

export function environment<T>(bindings: Iterable<readonly [string, T]> = [], parent?: Environment<T>): Environment<T> {
  return { bindings: new Map(bindings), ...(parent ? { parent } : {}) };
}

export function extend<T>(parent: Environment<T>, name: string, value: T): Environment<T> {
  return environment([[name, value]], parent);
}

export function lookup<T>(env: Environment<T>, name: string): T | undefined {
  for (let current: Environment<T> | undefined = env; current; current = current.parent) {
    if (current.bindings.has(name)) return current.bindings.get(name);
  }
  return undefined;
}
