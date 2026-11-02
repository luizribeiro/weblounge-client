import { describe, expect, it } from "vitest";
import { unreadBadge } from "./unread-badge";

describe("unreadBadge", () => {
  it.each([
    ["no unread", 0, 0, undefined],
    [
      "channel unread without mentions",
      3,
      0,
      { count: 3, kind: "unread", label: "3 unread" },
    ],
    [
      "channel unread including one mention",
      3,
      1,
      {
        count: 3,
        kind: "mention",
        label: "3 unread, including mentions",
      },
    ],
    [
      "unread direct messages",
      2,
      2,
      {
        count: 2,
        kind: "mention",
        label: "2 unread, including mentions",
      },
    ],
    [
      "counts over 99",
      100,
      0,
      { count: 100, kind: "unread", label: "100 unread" },
    ],
  ] as const)("derives %s", (_name, unread, mentions, expected) => {
    expect(unreadBadge({ mentions, unread })).toEqual(expected);
  });
});
