import { describe, expect, it } from "vitest";
import { redactionBars } from "./redaction-bars";

const msgids = Array.from(
  { length: 500 },
  (_, index) => `01JCX${index.toString(36).padStart(5, "0")}`,
);

describe("redactionBars", () => {
  it("draws the same bars for the same msgid", () => {
    expect(redactionBars("01JCXK4V7Q8")).toEqual(redactionBars("01JCXK4V7Q8"));
    expect(redactionBars("01JCXK4V7Q8")).toMatchInlineSnapshot(`
      [
        5,
        7,
        6,
        3,
        4,
      ]
    `);
  });

  it("always draws 3 to 8 word-like bars", () => {
    for (const msgid of msgids) {
      const bars = redactionBars(msgid);
      expect(bars.length).toBeGreaterThanOrEqual(3);
      expect(bars.length).toBeLessThanOrEqual(8);
      for (const width of bars) {
        expect(Number.isInteger(width)).toBe(true);
        expect(width).toBeGreaterThanOrEqual(2);
        expect(width).toBeLessThanOrEqual(9);
      }
    }
  });

  it("varies across msgids, using every count", () => {
    const patterns = new Set(
      msgids.map((msgid) => redactionBars(msgid).join()),
    );
    const counts = new Set(msgids.map((msgid) => redactionBars(msgid).length));
    expect(patterns.size).toBeGreaterThan(400);
    expect([...counts].sort()).toEqual([3, 4, 5, 6, 7, 8]);
  });
});
