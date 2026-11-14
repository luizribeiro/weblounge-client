import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = dirname(fileURLToPath(import.meta.url));

describe("CSS modules", () => {
  it("scope every rule to the module's own classes", () => {
    const unscoped = cssModules(source).flatMap((file) =>
      unscopedSelectors(readFileSync(file, "utf8")).map(
        (selector) => `${file.slice(source.length + 1)}: ${selector}`,
      ),
    );

    expect(unscoped).toEqual([]);
  });

  it("flags element, attribute and negated selectors that leak", () => {
    expect(
      unscopedSelectors(`
        /* h3 { } stays a comment */
        h2 { text-align: center; }
        .sheet h2, :global(#root[data-x]) .sheet { margin: 0; }
        a[href$=".pdf"] { color: inherit; }
        h2:not(.title) { margin: 0; }
        @media (min-width: 1px) { .title { margin: 0; } }
        @keyframes pulse { 0%, 12.5% { opacity: 0; } to { opacity: 1; } }
      `),
    ).toEqual(["h2", 'a[href$=".pdf"]', "h2:not(.title)"]);
  });
});

function cssModules(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return cssModules(path);
    return entry.name.endsWith(".module.css") ? [path] : [];
  });
}

function unscopedSelectors(css: string): string[] {
  const withoutComments = css.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
  return [...withoutComments.matchAll(/([^{};]+)\{/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((prelude) => !prelude.startsWith("@"))
    .flatMap((prelude) => prelude.split(",").map((part) => part.trim()))
    .filter((selector) => !/^(?:from|to|\d+(?:\.\d+)?%)$/u.test(selector))
    .filter((selector) => !isScoped(selector));
}

function isScoped(selector: string): boolean {
  if (selector.includes(":global")) return true;
  const ownCompounds = selector
    .replaceAll(/\[[^\]]*\]/gu, "")
    .replaceAll(/:(?:not|is|where|has)\([^)]*\)/gu, "");
  return /\.[A-Za-z_-]/u.test(ownCompounds);
}
