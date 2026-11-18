import { describe, expect, it } from "vitest";
import { contentFittingHeight, withBlockSizeHeld } from "./geometry";

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

function textareaMeasuring(sizes: {
  readonly clientHeight: number;
  readonly offsetHeight: number;
  readonly scrollHeight: number;
}): HTMLTextAreaElement {
  const textarea = document.createElement("textarea");
  for (const [name, value] of Object.entries(sizes))
    Object.defineProperty(textarea, name, { value });
  return textarea;
}

describe("contentFittingHeight", () => {
  it("adds a bordered desktop field's borders to three padded lines", () => {
    const textarea = textareaMeasuring({
      clientHeight: 38,
      offsetHeight: 40,
      scrollHeight: 78,
    });

    expect(contentFittingHeight(textarea)).toBe(80);
  });

  it("is the scroll height of a borderless phone field", () => {
    const textarea = textareaMeasuring({
      clientHeight: 44,
      offsetHeight: 44,
      scrollHeight: 88,
    });

    expect(contentFittingHeight(textarea)).toBe(88);
  });
});
