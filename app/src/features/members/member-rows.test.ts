import { expect, it } from "vitest";
import type { Member } from "./MemberRow";
import { memberRowAt, memberRowCount } from "./member-rows";

const online: Member = {
  group: "online",
  nick: "mel",
  mode_symbol: null,
  away: false,
  bot: false,
  account: "mel",
  nick_color_index: 1,
  is_you: false,
};

it("maps fixed group counts without expanding the whole member list", () => {
  const counts = [2, 0, 1_284, 402, 1] as const;
  expect(memberRowCount(counts)).toBe(1_693);
  expect(memberRowAt(0, counts, 0, [])).toEqual({
    kind: "group",
    group: "operators",
    count: 2,
  });
  expect(memberRowAt(3, counts, 0, [])).toEqual({
    kind: "group",
    group: "online",
    count: 1_284,
  });
  expect(memberRowAt(1_288, counts, 0, [])).toEqual({
    kind: "group",
    group: "away",
    count: 402,
  });
});

it("places a bounded window at its global member offset", () => {
  const row = memberRowAt(102, [1, 0, 200, 0, 0], 100, [online]);
  expect(row).toEqual({
    kind: "member",
    group: "online",
    memberIndex: 100,
    member: online,
  });
});
