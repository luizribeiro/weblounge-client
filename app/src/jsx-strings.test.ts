import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import { expect, it } from "vitest";

const visibleAttributes = new Set([
  "aria-description",
  "aria-label",
  "alt",
  "placeholder",
  "title",
]);

it("keeps user-facing component copy in the strings table", () => {
  const sourceRoot = resolve(process.cwd(), "src");
  const violations = sourceFiles(sourceRoot)
    .filter((file) => !file.endsWith(".test.tsx"))
    .flatMap((file) => violationsIn(file, sourceRoot));

  expect(violations).toEqual([]);
});

function violationsIn(file: string, sourceRoot: string): string[] {
  const source = readFileSync(file, "utf8");
  const ast = parse(source, {
    plugins: ["jsx", "typescript"],
    sourceType: "module",
  });
  const violations: string[] = [];
  const report = (node: NodeRecord, copy: string) => {
    if (!/[\p{L}\p{N}]/u.test(copy)) return;
    const position = asRecord(asRecord(node.loc)?.start);
    violations.push(
      `${relative(sourceRoot, file)}:${position?.line ?? 0}:${position?.column ?? 0} ${JSON.stringify(copy)}`,
    );
  };
  visit(ast, (node, parent) => {
    if (node.type === "JSXText") report(node, stringValue(node).trim());
    if (
      node.type === "JSXAttribute" &&
      visibleAttributes.has(attributeName(node))
    ) {
      const value = asRecord(node.value);
      if (value?.type === "StringLiteral") report(value, stringValue(value));
      if (value?.type === "JSXExpressionContainer") {
        const expression = asRecord(value.expression);
        if (expression !== undefined)
          inspectRenderedExpression(expression, report);
      }
    }
    if (
      node.type === "JSXExpressionContainer" &&
      parent?.type !== "JSXAttribute"
    ) {
      const expression = asRecord(node.expression);
      if (expression !== undefined)
        inspectRenderedExpression(expression, report);
    }
  });
  return violations;
}

function inspectRenderedExpression(
  expression: NodeRecord,
  report: (node: NodeRecord, copy: string) => void,
): void {
  if (
    expression.type === "StringLiteral" ||
    expression.type === "TemplateLiteral"
  ) {
    report(expression, stringValue(expression) || expressionText(expression));
    return;
  }
  if (expression.type === "ConditionalExpression") {
    inspectChild(expression.consequent, report);
    inspectChild(expression.alternate, report);
    return;
  }
  if (expression.type === "LogicalExpression") {
    if (expression.operator === "&&") inspectChild(expression.right, report);
    if (expression.operator === "||" || expression.operator === "??") {
      inspectChild(expression.left, report);
      inspectChild(expression.right, report);
    }
    return;
  }
  if (expression.type === "ArrayExpression") {
    const elements = Array.isArray(expression.elements)
      ? expression.elements
      : [];
    for (const element of elements) inspectChild(element, report);
  }
}

function inspectChild(
  value: unknown,
  report: (node: NodeRecord, copy: string) => void,
): void {
  const child = asRecord(value);
  if (child !== undefined) inspectRenderedExpression(child, report);
}

function attributeName(node: NodeRecord): string {
  const name = asRecord(node.name);
  if (name?.type === "JSXIdentifier") return stringValue(name);
  return "";
}

function expressionText(node: NodeRecord): string {
  const quasis = Array.isArray(node.quasis) ? node.quasis : [];
  return quasis
    .map((quasi) => stringValue(asRecord(asRecord(quasi)?.value)?.raw))
    .join("");
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (record === undefined) return "";
  for (const key of ["value", "name", "raw"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

type NodeRecord = Record<string, unknown>;

function asRecord(value: unknown): NodeRecord | undefined {
  return typeof value === "object" && value !== null
    ? (value as NodeRecord)
    : undefined;
}

function visit(
  value: unknown,
  visitor: (node: NodeRecord, parent: NodeRecord | undefined) => void,
  parent?: NodeRecord,
): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, visitor, parent);
    return;
  }
  const node = asRecord(value);
  if (node === undefined) return;
  if (typeof node.type === "string") visitor(node, parent);
  for (const [key, child] of Object.entries(node)) {
    if (key !== "loc" && key !== "extra") visit(child, visitor, node);
  }
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return extname(entry.name) === ".tsx" ? [path] : [];
  });
}
