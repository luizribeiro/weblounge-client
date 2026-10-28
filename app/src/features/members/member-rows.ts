import type { Member } from "./MemberRow";

export const memberGroups = [
  "operators",
  "voiced",
  "online",
  "away",
  "bots",
] as const;

export type MemberGroup = (typeof memberGroups)[number];
export type MemberCounts = readonly [number, number, number, number, number];

export type MemberListRow =
  | {
      readonly kind: "group";
      readonly group: MemberGroup;
      readonly count: number;
    }
  | {
      readonly kind: "member";
      readonly group: MemberGroup;
      readonly memberIndex: number;
      readonly member: Member | undefined;
    };

export function memberRowCount(counts: MemberCounts): number {
  return counts.reduce((total, count) => total + count + Number(count > 0), 0);
}

export function memberRowAt(
  rowIndex: number,
  counts: MemberCounts,
  windowOffset: number,
  members: readonly Member[],
): MemberListRow | undefined {
  let rowStart = 0;
  let memberStart = 0;
  for (const [groupIndex, group] of memberGroups.entries()) {
    const count = counts[groupIndex];
    if (count === undefined || count === 0) continue;
    if (rowIndex === rowStart) return { kind: "group", group, count };
    const localIndex = rowIndex - rowStart - 1;
    if (localIndex >= 0 && localIndex < count) {
      const memberIndex = memberStart + localIndex;
      return {
        kind: "member",
        group,
        memberIndex,
        member: members[memberIndex - windowOffset],
      };
    }
    rowStart += count + 1;
    memberStart += count;
  }
  return undefined;
}

export const memberGroupLabels: Readonly<Record<MemberGroup, string>> = {
  operators: "Operators",
  voiced: "Voiced",
  online: "Online",
  away: "Away",
  bots: "Bots",
};
