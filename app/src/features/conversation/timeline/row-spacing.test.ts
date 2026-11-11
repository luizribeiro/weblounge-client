import { describe, expect, it } from "vitest";
import { topPadding } from "./row-spacing";

describe("topPadding", () => {
  it.each([
    ["message", "line", "after-message"],
    ["line", "line", "after-line"],
    [undefined, "line", "after-line"],
    ["divider", "line", "after-divider"],
    ["divider", "message", "after-divider"],
  ] as const)("maps %s → %s to %s", (previous, row, expected) => {
    expect(topPadding(previous, row, "mobile")).toBe(expected);
    expect(topPadding(previous, row, "desktop")).toBe(expected);
  });
});
