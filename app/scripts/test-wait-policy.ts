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

const exemptibleReasons = new Set(["fixed sleep"]);

export function waitPolicyViolations(source: string, file = ""): Violation[] {
  const lines = source.split("\n");
  return lines.flatMap((text, index) => {
    const reason = lineViolation(text, file);
    if (reason === undefined) return [];
    const previous = lines[index - 1] ?? "";
    const exempt =
      exemptibleReasons.has(reason) &&
      (text.includes(exemption) || previous.includes(exemption));
    return exempt ? [] : [{ line: index + 1, reason, text: text.trim() }];
  });
}

function lineViolation(text: string, file: string): string | undefined {
  const rule = rules.find(({ pattern }) => pattern.test(text));
  if (rule?.reason === "slowed test timeout" && isPerformanceSpec(file))
    return undefined;
  if (rule !== undefined) return rule.reason;
  const timeout = /\btimeout\s*:\s*([\d_]+)/.exec(text)?.[1];
  if (
    timeout !== undefined &&
    Number(timeout.replaceAll("_", "")) > maxExplicitTimeoutMilliseconds
  )
    return "raised timeout";
  return undefined;
}

function isPerformanceSpec(file: string): boolean {
  return /-performance\.spec\.ts$/.test(file);
}

function main(files: readonly string[]): number {
  let failures = 0;
  for (const file of files) {
    for (const violation of waitPolicyViolations(
      readFileSync(file, "utf8"),
      file,
    )) {
      failures += 1;
      console.error(
        `${file}:${violation.line}: ${violation.reason}: ${violation.text}`,
      );
    }
  }
  if (failures > 0)
    console.error(
      `Wait for a condition instead (expect/poll, an event, page.clock). Only a fixed sleep that measures a window may carry "// ${exemption} <why>"; raised timeouts and test.slow() are never exempt (performance specs may use test.slow()).`,
    );
  return failures > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`)
  process.exit(main(process.argv.slice(2)));
