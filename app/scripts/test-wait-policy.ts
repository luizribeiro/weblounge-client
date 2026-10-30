import { readFileSync } from "node:fs";

const maxExplicitTimeoutMilliseconds = 5_000;
const exemption = "wait-ok:";

const rules: readonly { readonly reason: string; readonly pattern: RegExp }[] =
  [
    { reason: "fixed sleep", pattern: /\bwaitForTimeout\s*\(/ },
    {
      reason: "fixed sleep",
      pattern: /new Promise[^\n]*setTimeout\s*\(\s*resolve/,
    },
    { reason: "test retries", pattern: /\bretries\s*:/ },
    { reason: "slowed test timeout", pattern: /\btest\.slow\s*\(/ },
    { reason: "slowed test timeout", pattern: /\btest\.setTimeout\s*\(/ },
  ];

export interface Violation {
  readonly line: number;
  readonly reason: string;
  readonly text: string;
}

export function waitPolicyViolations(source: string): Violation[] {
  return source.split("\n").flatMap((text, index) => {
    const nextLine = source.split("\n")[index + 1] ?? "";
    if (text.includes(exemption) || nextLine.includes(exemption)) return [];
    const reason = lineViolation(text);
    return reason === undefined
      ? []
      : [{ line: index + 1, reason, text: text.trim() }];
  });
}

function lineViolation(text: string): string | undefined {
  const rule = rules.find(({ pattern }) => pattern.test(text));
  if (rule !== undefined) return rule.reason;
  const timeout = /\btimeout\s*:\s*([\d_]+)/.exec(text)?.[1];
  if (
    timeout !== undefined &&
    Number(timeout.replaceAll("_", "")) > maxExplicitTimeoutMilliseconds
  )
    return "raised timeout";
  return undefined;
}

function main(files: readonly string[]): number {
  let failures = 0;
  for (const file of files) {
    for (const violation of waitPolicyViolations(readFileSync(file, "utf8"))) {
      failures += 1;
      console.error(
        `${file}:${violation.line}: ${violation.reason}: ${violation.text}`,
      );
    }
  }
  if (failures > 0)
    console.error(
      `Wait for a condition instead (expect/poll, an event, page.clock). A wait that measures a fixed window needs a "// ${exemption} <why>" comment on that line or the line above.`,
    );
  return failures > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`)
  process.exit(main(process.argv.slice(2)));
