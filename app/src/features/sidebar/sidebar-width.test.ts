import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { sidebarWidth, sidebarWidthToken } from "./sidebar-width";

it("matches the token that sizes the inline sidebar and its drawer", () => {
  const css = readFileSync("src/styles/base.css", "utf8");
  const declarations = [...css.matchAll(/--wl-size-sidebar:\s*(\d+)px;/gu)];
  expect(declarations.map((match) => Number(match[1]))).toEqual([sidebarWidth]);
  expect(sidebarWidthToken).toBe("var(--wl-size-sidebar)");
});
