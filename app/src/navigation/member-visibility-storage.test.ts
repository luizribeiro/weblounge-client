import { expect, it } from "vitest";
import {
  type ChannelKey,
  hiddenMembers,
  membersShown,
  toggleMembers,
} from "./member-visibility";
import {
  decodeMemberVisibility,
  encodeMemberVisibility,
  readMemberVisibility,
  writeMemberVisibility,
} from "./member-visibility-storage";

const papo = "9:weblounge:rfc1459:#papo" as ChannelKey;
const lounge = "9:weblounge:rfc1459:#lounge" as ChannelKey;

it("round-trips per-channel choices and the last choice", () => {
  const visibility = toggleMembers(toggleMembers(hiddenMembers, papo), lounge);
  const decoded = decodeMemberVisibility(encodeMemberVisibility(visibility));
  expect(membersShown(decoded, papo)).toBe(true);
  expect(membersShown(decoded, lounge)).toBe(false);
  expect(decoded.lastChoice).toBe(false);
});

it.each([
  ["nothing stored", null],
  ["malformed JSON", "{"],
  ["a non-object", "[true]"],
  ["a future format", '{"version":2,"lastChoice":true,"channels":{}}'],
  ["a missing last choice", '{"version":1,"channels":{}}'],
  ["channels as a list", '{"version":1,"lastChoice":true,"channels":[]}'],
])("falls back to hidden members for %s", (_label, text) => {
  expect(decodeMemberVisibility(text)).toBe(hiddenMembers);
});

it("drops individual channel entries that are not booleans", () => {
  const decoded = decodeMemberVisibility(
    JSON.stringify({
      version: 1,
      lastChoice: true,
      channels: { [papo]: false, [lounge]: "yes" },
    }),
  );
  expect([...decoded.byChannel]).toEqual([[papo, false]]);
  expect(membersShown(decoded, lounge)).toBe(true);
});

it("persists through device storage", () => {
  writeMemberVisibility(toggleMembers(hiddenMembers, papo));
  expect(membersShown(readMemberVisibility(), papo)).toBe(true);
});

it("keeps working when device storage throws", () => {
  const failing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  } as unknown as Storage;
  expect(() =>
    writeMemberVisibility(toggleMembers(hiddenMembers, papo), failing),
  ).not.toThrow();
  expect(readMemberVisibility(failing)).toBe(hiddenMembers);
});
