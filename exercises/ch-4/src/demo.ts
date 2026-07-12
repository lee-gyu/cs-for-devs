import { evaluate, formatType, infer, parse } from "./index.ts";

const sources = [
  "fun x -> x",
  "let id = fun x -> x in let ignored = id(1) in id(true)",
  "fun x -> x(x)",
];

for (const source of sources) {
  const ast = parse(source), inferred = infer(ast);
  console.log(`\n${source}`);
  console.log("type:", inferred.ok ? formatType(inferred.type) : inferred.error);
  console.log("trace:", inferred.trace);
  console.log("evaluation:", evaluate(ast));
}
