import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("ships the compact chair mark in the sidebar asset slot", () => {
  const chair = readFileSync("public/brand/chair.svg", "utf8");

  expect(chair).toContain('viewBox="0 0 16 16"');
  expect(chair).toContain('<g id="mark">');
  expect(chair).not.toContain("chair-edges");
});
