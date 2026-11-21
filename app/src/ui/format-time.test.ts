import { describe, expect, it } from "vitest";
import {
  formatShortDate,
  formatTime,
  formatTimeOrDate,
  widestTimeLength,
} from "./format-time";

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

describe("formatTimeOrDate", () => {
  const now = new Date(2026, 10, 21, 18, 30).getTime();

  it("shows only the time for a moment earlier today", () => {
    const today = new Date(2026, 10, 21, 14, 5).getTime();

    expect(formatTimeOrDate(today, now)).toBe(formatTime(today));
  });

  it("shows only the short date for a moment on another day", () => {
    const yesterday = new Date(2026, 10, 20, 23, 55).getTime();

    expect(formatTimeOrDate(yesterday, now)).toBe(formatShortDate(yesterday));
  });
});
