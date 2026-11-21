import { describe, expect, it } from "vitest";
import { formatShortDate, formatTime } from "../../ui/format-time";
import { presenceStatus } from "./presence-status";

const now = new Date(2026, 10, 21, 18, 30).getTime();
const earlierToday = new Date(2026, 10, 21, 14, 5).getTime();
const yesterday = new Date(2026, 10, 20, 23, 55).getTime();

describe("presenceStatus", () => {
  it.each([
    ["online", undefined, "Online"],
    ["online", earlierToday, "Online"],
    ["away", undefined, "Away"],
    ["offline", undefined, "Offline"],
  ] as const)(
    "names %s without a time when none was seen (%s)",
    (presence, since, text) => {
      expect(presenceStatus(presence, since, now)).toBe(text);
    },
  );

  it("says since when a peer went away today", () => {
    expect(presenceStatus("away", earlierToday, now)).toBe(
      `Away since ${formatTime(earlierToday)}`,
    );
  });

  it("says when an offline peer was last seen, by date before today", () => {
    expect(presenceStatus("offline", yesterday, now)).toBe(
      `Offline, last seen ${formatShortDate(yesterday)}`,
    );
  });
});
