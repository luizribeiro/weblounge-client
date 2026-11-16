import { expect, it } from "vitest";
import type { BufferProjection } from "../engine/protocol";
import {
  type ChannelKey,
  channelKey,
  hiddenMembers,
  membersShown,
  toggleMembers,
} from "./member-visibility";

const papo = "9:weblounge:rfc1459:#papo" as ChannelKey;
const lounge = "9:weblounge:rfc1459:#lounge" as ChannelKey;
const fresh = "9:weblounge:rfc1459:#fresh" as ChannelKey;

it("hides members for every channel until one is toggled", () => {
  expect(membersShown(hiddenMembers, papo)).toBe(false);
  expect(membersShown(hiddenMembers, lounge)).toBe(false);
});

it("remembers each channel and lets untoggled channels follow the last choice", () => {
  const papoShown = toggleMembers(hiddenMembers, papo);
  expect(membersShown(papoShown, papo)).toBe(true);
  expect(membersShown(papoShown, lounge)).toBe(true);

  const loungeHidden = toggleMembers(papoShown, lounge);
  expect(membersShown(loungeHidden, lounge)).toBe(false);
  expect(membersShown(loungeHidden, papo)).toBe(true);
  expect(membersShown(loungeHidden, fresh)).toBe(false);
});

it("leaves the previous visibility untouched when toggling", () => {
  toggleMembers(hiddenMembers, papo);
  expect(hiddenMembers.byChannel.size).toBe(0);
  expect(hiddenMembers.lastChoice).toBe(false);
});

it("keys channels by their folded durable identity and skips other buffers", () => {
  const papoBuffer: BufferProjection = {
    id: 2,
    network_id: 1,
    sync_state: "synced",
    kind: "channel",
    title: "#Papo",
    draft_key: papo,
    topic: null,
    unread: 0,
    mentions: 0,
  };
  expect(channelKey(papoBuffer)).toBe(papo);
  expect(channelKey({ ...papoBuffer, id: 9, title: "#PAPO" })).toBe(papo);
  expect(
    channelKey({ ...papoBuffer, kind: "direct", title: "mel" }),
  ).toBeUndefined();
  expect(
    channelKey({ ...papoBuffer, kind: "server", title: "weblounge" }),
  ).toBeUndefined();
});
