import type { BinaryOperator, Expression, Span } from "./language.ts";

type TokenKind = "number" | "identifier" | "true" | "false" | "if" | "then" | "else" | "fun" | "let" | "in" | "arrow" | "operator" | "lparen" | "rparen" | "equal" | "eof";
type Token = { kind: TokenKind; text: string; span: Span };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    if (/\s/u.test(source[index]!)) { index++; continue; }
    const start = index;
    const number = source.slice(index).match(/^\d+(?:\.\d+)?/u);
    if (number) { index += number[0].length; tokens.push({ kind: "number", text: number[0], span: { start, end: index } }); continue; }
    const word = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/u);
    if (word) {
      index += word[0].length;
      const keywords = new Set(["true", "false", "if", "then", "else", "fun", "let", "in"]);
      tokens.push({ kind: keywords.has(word[0]) ? word[0] as TokenKind : "identifier", text: word[0], span: { start, end: index } }); continue;
    }
    const symbol = ["->", "==", "<=", "+", "-", "*", "/", "<", "(", ")", "="].find((candidate) => source.startsWith(candidate, index));
    if (!symbol) throw new SyntaxError(`unexpected character at ${index}: ${source[index]}`);
    index += symbol.length;
    const kind: TokenKind = symbol === "->" ? "arrow" : symbol === "(" ? "lparen" : symbol === ")" ? "rparen" : symbol === "=" ? "equal" : "operator";
    tokens.push({ kind, text: symbol, span: { start, end: index } });
  }
  tokens.push({ kind: "eof", text: "", span: { start: index, end: index } });
  return tokens;
}

export function parse(source: string): Expression {
  const tokens = tokenize(source); let current = 0;
  const peek = () => tokens[current]!;
  const take = (kind: TokenKind): Token => { const token = peek(); if (token.kind !== kind) throw new SyntaxError(`expected ${kind} at ${token.span.start}, found ${token.text || "EOF"}`); current++; return token; };
  const merge = (a: Span, b: Span): Span => ({ start: a.start, end: b.end });

  function expression(): Expression {
    if (peek().kind === "let") {
      const start = take("let"), name = take("identifier"); take("equal"); const value = expression(); take("in"); const body = expression();
      return { kind: "let", name: name.text, value, body, span: merge(start.span, body.span) };
    }
    if (peek().kind === "if") {
      const start = take("if"), condition = expression(); take("then"); const then = expression(); take("else"); const otherwise = expression();
      return { kind: "if", condition, then, otherwise, span: merge(start.span, otherwise.span) };
    }
    if (peek().kind === "fun") {
      const start = take("fun"), parameter = take("identifier"); take("arrow"); const body = expression();
      return { kind: "function", parameter: parameter.text, body, span: merge(start.span, body.span) };
    }
    return binary(0);
  }

  const precedence: Record<string, number> = { "==": 1, "<": 2, "<=": 2, "+": 3, "-": 3, "*": 4, "/": 4 };
  function binary(minimum: number): Expression {
    let left = call();
    while (peek().kind === "operator" && precedence[peek().text]! >= minimum) {
      const operator = take("operator"), level = precedence[operator.text]!, right = binary(level + 1);
      left = { kind: "binary", operator: operator.text as BinaryOperator, left, right, span: merge(left.span, right.span) };
    }
    return left;
  }
  function call(): Expression {
    let result = atom();
    while (peek().kind === "lparen") { take("lparen"); const argument = expression(); const end = take("rparen"); result = { kind: "call", callee: result, argument, span: merge(result.span, end.span) }; }
    return result;
  }
  function atom(): Expression {
    const token = peek();
    if (token.kind === "number") { take("number"); return { kind: "number", value: Number(token.text), span: token.span }; }
    if (token.kind === "true" || token.kind === "false") { current++; return { kind: "boolean", value: token.kind === "true", span: token.span }; }
    if (token.kind === "identifier") { take("identifier"); return { kind: "variable", name: token.text, span: token.span }; }
    if (token.kind === "lparen") { take("lparen"); const inner = expression(); take("rparen"); return inner; }
    throw new SyntaxError(`expected expression at ${token.span.start}`);
  }
  const result = expression(); take("eof"); return result;
}
