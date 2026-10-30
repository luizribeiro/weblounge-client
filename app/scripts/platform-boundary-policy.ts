import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Rule {
  readonly reason: string;
  readonly pattern: RegExp;
}

export interface PlatformBoundaryViolation {
  readonly line: number;
  readonly reason: string;
}

const rules: readonly Rule[] = [
  {
    reason: "safe-area env() belongs to the platform token file",
    pattern: /env\(\s*safe-area-inset-/gu,
  },
  {
    reason: "media queries belong to the platform environment",
    pattern: /\bmatchMedia\s*\(/gu,
  },
  {
    reason: "navigator platform detection belongs to the platform environment",
    pattern: /\bnavigator\.(?:platform|userAgent(?:Data)?)/gu,
  },
  {
    reason: "width breakpoints belong to the platform environment",
    pattern: /@media\s*[^{]*\(\s*max-width\s*:/gu,
  },
];

export function platformBoundaryViolations(
  file: string,
  source: string,
): PlatformBoundaryViolation[] {
  if (normalized(file).startsWith("app/src/platform/")) return [];
  return rules.flatMap(({ reason, pattern }) =>
    [...source.matchAll(pattern)].map((match) => ({
      line: lineAt(source, match.index),
      reason,
    })),
  );
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function normalized(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:css|ts|tsx)$/u.test(entry.name) ? [path] : [];
  });
}

function main(): number {
  let failures = 0;
  for (const file of sourceFiles("app/src")) {
    const relative = normalized(file).replace(
      `${normalized(process.cwd())}/`,
      "",
    );
    for (const violation of platformBoundaryViolations(
      relative,
      readFileSync(file, "utf8"),
    )) {
      failures += 1;
      console.error(`${relative}:${violation.line}: ${violation.reason}`);
    }
  }
  return failures > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
