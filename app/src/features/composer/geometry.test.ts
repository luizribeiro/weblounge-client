import { describe, expect, it } from "vitest";
import { withBlockSizeHeld } from "./geometry";

function rowOfHeight(height: number): HTMLElement {
  const row = document.createElement("div");
  row.getBoundingClientRect = () => new DOMRect(0, 0, 320, height);
  return row;
}

describe("withBlockSizeHeld", () => {
  it("keeps the laid-out block size while the measurement runs", () => {
    const row = rowOfHeight(66);

    const held = withBlockSizeHeld(row, () => row.style.blockSize);

    expect(held).toBe("66px");
  });

  it("restores the inline block size after measuring", () => {
    const row = rowOfHeight(66);
    row.style.blockSize = "40px";

    expect(withBlockSizeHeld(row, () => 88)).toBe(88);
    expect(row.style.blockSize).toBe("40px");
  });

  it("restores the inline block size when the measurement throws", () => {
    const row = rowOfHeight(66);

    expect(() =>
      withBlockSizeHeld(row, () => {
        throw new Error("detached textarea");
      }),
    ).toThrow("detached textarea");
    expect(row.style.blockSize).toBe("");
  });

  it("measures directly without an element to hold", () => {
    expect(withBlockSizeHeld(null, () => "44px")).toBe("44px");
  });
});
