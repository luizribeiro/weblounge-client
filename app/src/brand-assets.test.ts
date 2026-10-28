import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("ships only the chair glyph on a transparent canvas", () => {
  const chair = readFileSync("public/brand/chair.svg", "utf8");

  expect(chair).toContain('viewBox="0 0 16 16"');
  expect(chair).toContain('<g id="mark">');
  expect(chair).not.toMatch(/<rect\b/);
  expect(chair.match(/<path\b/g)).toHaveLength(2);
});
