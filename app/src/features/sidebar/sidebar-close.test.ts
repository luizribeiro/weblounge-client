import { describe, expect, it } from "vitest";
import { focusAfterClose } from "./sidebar-close";

describe("focusAfterClose", () => {
  it("moves to the row below", () => {
    expect(focusAfterClose([1, 2, 3], 2)).toBe(3);
  });

  it("moves above when the last row closes", () => {
    expect(focusAfterClose([1, 2, 3], 3)).toBe(2);
  });

  it("leaves no target after the only row closes", () => {
    expect(focusAfterClose([2], 2)).toBeUndefined();
  });
});
