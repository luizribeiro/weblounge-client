import { describe, expect, it } from "vitest";
import {
  formatMonthYear,
  formatShortDate,
  formatTime,
  formatWeekday,
} from "../../ui/format-time";
import { presenceStatus, presenceTime } from "./presence-status";

const at = (...parts: [number, number, number, number, number]) =>
  new Date(...parts).getTime();
const now = at(2026, 10, 21, 0, 20);

describe("presenceStatus", () => {
  it.each([
    ["online", undefined, "Online"],
    ["online", at(2026, 10, 21, 0, 5), "Online"],
    ["away", undefined, "Away"],
    ["offline", undefined, "Offline"],
  ] as const)(
    "names %s without a time when none was seen (%s)",
    (presence, since, text) => {
      expect(presenceStatus(presence, since, now)).toBe(text);
    },
  );

  it("says since when a peer went away today", () => {
    const since = at(2026, 10, 21, 0, 5);

    expect(presenceStatus("away", since, now)).toBe(
      `Away since ${formatTime(since)}`,
    );
  });

  it("says when an offline peer was last seen", () => {
    const since = at(2026, 10, 20, 23, 50);

    expect(presenceStatus("offline", since, now)).toBe(
      `Offline, last seen yesterday ${formatTime(since)}`,
    );
  });
});

describe("presenceTime", () => {
  it("shows the clock time earlier today", () => {
    const since = at(2026, 10, 21, 0, 5);

    expect(presenceTime(since, now)).toBe(formatTime(since));
  });

  it("says yesterday with the time just across midnight", () => {
    const since = at(2026, 10, 20, 23, 50);

    expect(presenceTime(since, now)).toBe(`yesterday ${formatTime(since)}`);
  });

  it("says yesterday for the very start of the previous day", () => {
    const since = at(2026, 10, 20, 0, 0);

    expect(presenceTime(since, now)).toBe(`yesterday ${formatTime(since)}`);
  });

  it.each([2, 6])("names the weekday %i days back", (days) => {
    const since = at(2026, 10, 21 - days, 12, 0);

    expect(presenceTime(since, now)).toBe(formatWeekday(since));
  });

  it("switches to the date a week back", () => {
    const since = at(2026, 10, 14, 23, 59);

    expect(presenceTime(since, now)).toBe(formatShortDate(since));
  });

  it("keeps the date without a year within the same year", () => {
    const since = at(2026, 0, 3, 9, 0);

    expect(presenceTime(since, now)).toBe(formatShortDate(since));
  });

  it("says yesterday across the new year", () => {
    const newYear = at(2027, 0, 1, 0, 10);
    const since = at(2026, 11, 31, 23, 50);

    expect(presenceTime(since, newYear)).toBe(`yesterday ${formatTime(since)}`);
  });

  it("names the weekday across the new year within the week", () => {
    const newYear = at(2027, 0, 1, 0, 10);
    const since = at(2026, 11, 28, 18, 0);

    expect(presenceTime(since, newYear)).toBe(formatWeekday(since));
  });

  it("gives month and year once it is a different year", () => {
    const newYear = at(2027, 0, 1, 0, 10);
    const since = at(2026, 11, 20, 18, 0);

    expect(presenceTime(since, newYear)).toBe(formatMonthYear(since));
  });

  it("treats a time ahead of the clock as today", () => {
    const since = at(2026, 10, 21, 0, 25);

    expect(presenceTime(since, now)).toBe(formatTime(since));
  });
});
