import { describe, expect, it } from "vitest";
import { widestTimeLength } from "./format-time";

describe("widestTimeLength", () => {
  it("accounts for 12-hour and 24-hour locale output", () => {
    const twelveHour = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    const twentyFourHour = new Intl.DateTimeFormat("de-DE", {
      hour: "numeric",
      minute: "2-digit",
    });

    expect(widestTimeLength(twelveHour)).toBeGreaterThanOrEqual(
      Array.from(twelveHour.format(new Date(2026, 0, 1, 12, 25))).length,
    );
    expect(widestTimeLength(twentyFourHour)).toBeGreaterThanOrEqual(
      Array.from(twentyFourHour.format(new Date(2026, 0, 1, 0, 0))).length,
    );
  });
});
