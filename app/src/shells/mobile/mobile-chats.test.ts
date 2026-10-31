import { expect, it } from "vitest";
import { connectionSummary } from "../../engine/connection-state";
import type {
  BufferProjection,
  NetworkProjection,
} from "../../engine/protocol";
import { filterChats, networkLabel } from "./mobile-chats";

const buffers: BufferProjection[] = [
  buffer(1, "server", "Local"),
  buffer(2, "channel", "#garden", 2),
  buffer(3, "channel", "#quiet"),
  buffer(4, "direct", "mel", 1),
];
const networks: NetworkProjection[] = [
  { id: 1, label: "Local", nickname: "me", state: "online" },
  { id: 2, label: "Libera", nickname: "me", state: "online" },
];

it("applies each chat filter without server buffers", () => {
  expect(filterChats(buffers, "all", "").map((item) => item.id)).toEqual([
    2, 3, 4,
  ]);
  expect(filterChats(buffers, "unread", "").map((item) => item.id)).toEqual([
    2, 4,
  ]);
  expect(filterChats(buffers, "channels", "").map((item) => item.id)).toEqual([
    2, 3,
  ]);
  expect(filterChats(buffers, "direct", "").map((item) => item.id)).toEqual([
    4,
  ]);
});

it("searches names and engine-projected previews locally", () => {
  expect(filterChats(buffers, "all", "GARD").map((item) => item.id)).toEqual([
    2,
  ]);
  expect(filterChats(buffers, "all", "latest").map((item) => item.id)).toEqual([
    4,
  ]);
});

it("labels only non-default networks and summarizes connection state", () => {
  expect(networkLabel(networks, 1)).toBeUndefined();
  expect(networkLabel(networks, 2)).toBe("Libera");
  expect(connectionSummary(networks)).toBe("");
  expect(
    connectionSummary([
      {
        id: 1,
        label: "Local",
        nickname: "me",
        state: { offline: { reason: "device_offline" } },
      },
    ]),
  ).toBe("Offline");
});

function buffer(
  id: number,
  kind: BufferProjection["kind"],
  title: string,
  unread = 0,
): BufferProjection {
  return {
    id,
    network_id: id === 3 ? 2 : 1,
    kind,
    title,
    draft_key: title,
    topic: null,
    unread,
    mentions: 0,
    read_through: null,
    ...(id === 4
      ? {
          last_message: {
            id: 1,
            author: "mel",
            text: "latest note",
            kind: "text" as const,
            bot: false,
            mode_symbol: null,
            authorship: "other" as const,
            nick_color_index: 0,
            highlighted: false,
            delivery: "received" as const,
            local_send_id: null,
            server_ids: [],
            server_time_ms: null,
            received_at_ms: 1,
          },
        }
      : {}),
  };
}
