import { describe, expect, it } from "vitest";
import {
  calendarDaysBefore,
  isSameLocalYear,
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

describe("calendarDaysBefore", () => {
  it("counts local calendar days, not 24-hour spans", () => {
    const now = new Date(2026, 10, 21, 0, 20).getTime();

    expect(
      calendarDaysBefore(new Date(2026, 10, 21, 0, 0).getTime(), now),
    ).toBe(0);
    expect(
      calendarDaysBefore(new Date(2026, 10, 20, 23, 59).getTime(), now),
    ).toBe(1);
    expect(
      calendarDaysBefore(new Date(2026, 10, 14, 0, 30).getTime(), now),
    ).toBe(7);
  });

  it("spans a daylight-saving change as whole days", () => {
    const after = new Date(2026, 3, 1, 12, 0).getTime();

    expect(
      calendarDaysBefore(new Date(2026, 2, 1, 12, 0).getTime(), after),
    ).toBe(31);
  });
});

describe("isSameLocalYear", () => {
  it("splits at the new year", () => {
    const newYear = new Date(2027, 0, 1, 0, 10).getTime();

    expect(
      isSameLocalYear(new Date(2026, 11, 31, 23, 50).getTime(), newYear),
    ).toBe(false);
    expect(isSameLocalYear(new Date(2027, 0, 1, 0, 0).getTime(), newYear)).toBe(
      true,
    );
  });
});
