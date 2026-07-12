import { BOOLEAN, NUMBER, environment, extend, lookup, type Environment, type Expression, type InferResult, type InferTraceEvent, type Span, type Type, type TypeDiagnostic, type TypeEnvironment, type TypeScheme } from "./language.ts";

type Substitution = Map<number, Type>;
type State = { next: number; substitution: Substitution; trace: InferTraceEvent[] };
class InferenceFailure {
  readonly diagnostic: TypeDiagnostic;
  constructor(diagnostic: TypeDiagnostic) { this.diagnostic = diagnostic; }
}

const variable = (id: number): Type => ({ kind: "variable", id });
const fn = (parameter: Type, result: Type): Type => ({ kind: "function", parameter, result });
const fresh = (state: State): Type => variable(state.next++);

function apply(type: Type, substitution: Substitution): Type {
  if (type.kind === "variable") {
    const replacement = substitution.get(type.id);
    return replacement ? apply(replacement, substitution) : type;
  }
  return type.kind === "function" ? fn(apply(type.parameter, substitution), apply(type.result, substitution)) : type;
}

function free(type: Type, result = new Set<number>()): Set<number> {
  if (type.kind === "variable") result.add(type.id);
  if (type.kind === "function") { free(type.parameter, result); free(type.result, result); }
  return result;
}

function freeScheme(scheme: TypeScheme): Set<number> {
  const result = free(scheme.type);
  for (const id of scheme.quantified) result.delete(id);
  return result;
}

function freeEnvironment(env: TypeEnvironment): Set<number> {
  const result = new Set<number>();
  for (let current: TypeEnvironment | undefined = env; current; current = current.parent) {
    for (const scheme of current.bindings.values()) for (const id of freeScheme(scheme)) result.add(id);
  }
  return result;
}

function occurs(id: number, type: Type, substitution: Substitution): boolean {
  return free(apply(type, substitution)).has(id);
}

function bind(id: number, type: Type, span: Span, state: State): void {
  const target = apply(type, state.substitution);
  if (target.kind === "variable" && target.id === id) return;
  if (occurs(id, target, state.substitution)) throw new InferenceFailure({ kind: "InfiniteType", variableId: id, type: target, span });
  state.substitution.set(id, target);
}

function unify(leftInput: Type, rightInput: Type, span: Span, state: State, callable = false): void {
  const left = apply(leftInput, state.substitution), right = apply(rightInput, state.substitution);
  state.trace.push({ kind: "Constraint", left, right, span });
  if (left.kind === "variable") bind(left.id, right, span, state);
  else if (right.kind === "variable") bind(right.id, left, span, state);
  else if (left.kind === "function" && right.kind === "function") {
    unify(left.parameter, right.parameter, span, state);
    unify(left.result, right.result, span, state);
  } else if (left.kind !== right.kind) {
    if (callable && left.kind !== "function") throw new InferenceFailure({ kind: "NotCallable", actual: left, span });
    throw new InferenceFailure({ kind: "TypeMismatch", expected: right, actual: left, span });
  }
  state.trace.push({ kind: "Unify", left, right, substitution: new Map(state.substitution) });
}

function instantiate(name: string, scheme: TypeScheme, span: Span, state: State): Type {
  const replacements = new Map<number, Type>();
  for (const id of scheme.quantified) replacements.set(id, fresh(state));
  const type = apply(scheme.type, replacements);
  state.trace.push({ kind: "Instantiate", name, scheme, type, span });
  return type;
}

function generalize(type: Type, env: TypeEnvironment, state: State): TypeScheme {
  const resolved = apply(type, state.substitution), environmentVariables = freeEnvironment(env);
  return { quantified: [...free(resolved)].filter((id) => !environmentVariables.has(id)).sort((a, b) => a - b), type: resolved };
}

function visit(expression: Expression, env: TypeEnvironment, state: State): Type {
  switch (expression.kind) {
    case "number": return NUMBER;
    case "boolean": return BOOLEAN;
    case "variable": {
      const scheme = lookup(env, expression.name);
      if (!scheme) throw new InferenceFailure({ kind: "UnboundVariable", name: expression.name, span: expression.span });
      return instantiate(expression.name, scheme, expression.span, state);
    }
    case "function": {
      const parameter = fresh(state);
      const body = visit(expression.body, extend(env, expression.parameter, { quantified: [], type: parameter }), state);
      return fn(apply(parameter, state.substitution), body);
    }
    case "call": {
      const callee = visit(expression.callee, env, state), argument = visit(expression.argument, env, state), result = fresh(state);
      unify(callee, fn(argument, result), expression.span, state, true);
      return apply(result, state.substitution);
    }
    case "let": {
      const value = visit(expression.value, env, state), scheme = generalize(value, env, state);
      state.trace.push({ kind: "Generalize", name: expression.name, scheme, span: expression.value.span });
      return visit(expression.body, extend(env, expression.name, scheme), state);
    }
    case "if": {
      const condition = visit(expression.condition, env, state);
      unify(condition, BOOLEAN, expression.condition.span, state);
      const thenType = visit(expression.then, env, state), otherwiseType = visit(expression.otherwise, env, state);
      unify(thenType, otherwiseType, expression.span, state);
      return apply(thenType, state.substitution);
    }
    case "binary": {
      const left = visit(expression.left, env, state), right = visit(expression.right, env, state);
      if (expression.operator === "==") {
        // 타입 클래스가 없는 기준 언어에서 ==는 숫자 동등성으로 고정한다.
        // 임의의 'a == 'a를 허용하면 closure도 잘 타입되어 실행 시 stuck된다.
        unify(left, NUMBER, expression.left.span, state);
        unify(right, NUMBER, expression.right.span, state);
        return BOOLEAN;
      }
      unify(left, NUMBER, expression.left.span, state);
      unify(right, NUMBER, expression.right.span, state);
      return expression.operator === "<" || expression.operator === "<=" ? BOOLEAN : NUMBER;
    }
  }
}

export function infer(expression: Expression, env: TypeEnvironment = environment()): InferResult {
  const state: State = { next: 0, substitution: new Map(), trace: [] };
  try { return { ok: true, type: apply(visit(expression, env, state), state.substitution), trace: state.trace }; }
  catch (error) {
    if (error instanceof InferenceFailure) return { ok: false, error: error.diagnostic, trace: state.trace };
    throw error;
  }
}

export function formatType(type: Type): string {
  const names = new Map<number, string>();
  const name = (id: number): string => {
    if (!names.has(id)) { const n = names.size; names.set(id, `'${String.fromCharCode(97 + n % 26)}${n >= 26 ? Math.floor(n / 26) : ""}`); }
    return names.get(id)!;
  };
  const render = (current: Type, nested = false): string => {
    if (current.kind === "number") return "Number";
    if (current.kind === "boolean") return "Boolean";
    if (current.kind === "variable") return name(current.id);
    const text = `${render(current.parameter, true)} -> ${render(current.result)}`;
    return nested ? `(${text})` : text;
  };
  return render(type);
}
