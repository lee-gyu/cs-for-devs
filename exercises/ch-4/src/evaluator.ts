import { environment, extend, lookup, type EvaluationResult, type Expression, type Value, type ValueEnvironment } from "./language.ts";

function invalid(expression: Extract<Expression, { kind: "binary" }>): EvaluationResult {
  return { ok: false, error: { kind: "InvalidOperand", operator: expression.operator, span: expression.span } };
}

export function evaluate(expression: Expression, env: ValueEnvironment = environment()): EvaluationResult {
  switch (expression.kind) {
    case "number": case "boolean": return { ok: true, value: expression.value };
    case "variable": {
      const value = lookup(env, expression.name);
      return value === undefined
        ? { ok: false, error: { kind: "UnboundVariable", name: expression.name, span: expression.span } }
        : { ok: true, value };
    }
    case "function":
      return { ok: true, value: { parameter: expression.parameter, body: expression.body, environment: env } };
    case "let": {
      const value = evaluate(expression.value, env);
      return value.ok ? evaluate(expression.body, extend(env, expression.name, value.value)) : value;
    }
    case "if": {
      const condition = evaluate(expression.condition, env);
      if (!condition.ok) return condition;
      if (typeof condition.value !== "boolean") return { ok: false, error: { kind: "InvalidOperand", operator: "if", span: expression.condition.span } };
      return evaluate(condition.value ? expression.then : expression.otherwise, env);
    }
    case "call": {
      const callee = evaluate(expression.callee, env);
      if (!callee.ok) return callee;
      if (typeof callee.value !== "object") return { ok: false, error: { kind: "NotCallable", span: expression.callee.span } };
      const argument = evaluate(expression.argument, env);
      if (!argument.ok) return argument;
      return evaluate(callee.value.body, extend(callee.value.environment, callee.value.parameter, argument.value));
    }
    case "binary": {
      const left = evaluate(expression.left, env);
      if (!left.ok) return left;
      const right = evaluate(expression.right, env);
      if (!right.ok) return right;
      const a = left.value, b = right.value;
      if (expression.operator === "==") {
        if ((typeof a !== "number" && typeof a !== "boolean") || typeof a !== typeof b) return invalid(expression);
        return { ok: true, value: a === b };
      }
      if (typeof a !== "number" || typeof b !== "number") return invalid(expression);
      if (expression.operator === "/" && b === 0) return { ok: false, error: { kind: "DivisionByZero", span: expression.span } };
      const value: Value = expression.operator === "+" ? a + b
        : expression.operator === "-" ? a - b
        : expression.operator === "*" ? a * b
        : expression.operator === "/" ? a / b
        : expression.operator === "<" ? a < b : a <= b;
      return { ok: true, value };
    }
  }
}
