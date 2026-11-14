import { describe, expect, it } from "vitest";
import { type TrailingSlotState, trailingSlot } from "./trailing-slot";

const idle: TrailingSlotState = {
  badge: false,
  closable: false,
  engaged: false,
};

describe("sidebar trailing slot", () => {
  it("swaps the badge for the close button while a closable row is hovered or focused", () => {
    expect(
      trailingSlot({ ...idle, badge: true, closable: true, engaged: true }),
    ).toBe("close");
    expect(trailingSlot({ ...idle, closable: true, engaged: true })).toBe(
      "close",
    );
  });

  it("keeps the badge on an engaged row that cannot close", () => {
    expect(trailingSlot({ ...idle, badge: true, engaged: true })).toBe("badge");
  });

  it("keeps the badge on a closable row at rest", () => {
    expect(trailingSlot({ ...idle, badge: true, closable: true })).toBe(
      "badge",
    );
  });

  it("is empty for a read row at rest", () => {
    expect(trailingSlot(idle)).toBe("empty");
    expect(trailingSlot({ ...idle, closable: true })).toBe("empty");
  });
});
