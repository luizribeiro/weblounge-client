import { expect, it } from "vitest";
import type {
  BufferProjection,
  NetworkProjection,
} from "../../engine/protocol";
import { filterChats, networkLabel, sortChatsByActivity } from "./mobile-chats";

const buffers: BufferProjection[] = [
  buffer(1, "server", "Local"),
  buffer(2, "channel", "#garden", 2, 200),
  buffer(3, "channel", "#quiet"),
  buffer(4, "direct", "mel", 1, 300),
];
const networks: NetworkProjection[] = [
  { id: 1, label: "Local", nickname: "me", state: "online" },
  { id: 2, label: "Libera", nickname: "me", state: "online" },
];

it("applies each chat filter without server buffers", () => {
  expect(filterChats(buffers, "all", "").map((item) => item.id)).toEqual([
    4, 2, 3,
  ]);
  expect(filterChats(buffers, "unread", "").map((item) => item.id)).toEqual([
    4, 2,
  ]);
  expect(filterChats(buffers, "channels", "").map((item) => item.id)).toEqual([
    2, 3,
  ]);
  expect(filterChats(buffers, "direct", "").map((item) => item.id)).toEqual([
    4,
  ]);
});

it("sorts mixed chats by activity with stable ties and missing times last", () => {
  const mixed = [
    buffer(10, "channel", "#tied-first", 0, 400),
    buffer(11, "direct", "newest", 0, 500),
    buffer(12, "direct", "tied-second", 0, 400),
    buffer(13, "channel", "#missing-first"),
    buffer(14, "direct", "missing-second"),
  ];

  expect(sortChatsByActivity(mixed).map((item) => item.id)).toEqual([
    11, 10, 12, 13, 14,
  ]);
  expect(mixed.map((item) => item.id)).toEqual([10, 11, 12, 13, 14]);
});

it("searches names and engine-projected previews locally", () => {
  expect(filterChats(buffers, "all", "GARD").map((item) => item.id)).toEqual([
    2,
  ]);
  expect(filterChats(buffers, "all", "latest").map((item) => item.id)).toEqual([
    4,
  ]);
  expect(
    filterChats(
      [
        buffer(20, "channel", "#project-match", 0, 200),
        buffer(21, "direct", "match-friend", 0, 300),
      ],
      "all",
      "match",
    ).map((item) => item.id),
  ).toEqual([21, 20]);
});

it("labels only non-default networks", () => {
  expect(networkLabel(networks, 1)).toBeUndefined();
  expect(networkLabel(networks, 2)).toBe("Libera");
});

function buffer(
  id: number,
  kind: BufferProjection["kind"],
  title: string,
  unread = 0,
  lastActivity?: number,
): BufferProjection {
  return {
    id,
    network_id: id === 3 ? 2 : 1,
    sync_state: "synced",
    kind,
    title,
    draft_key: title,
    topic: null,
    unread,
    mentions: 0,
    ...(lastActivity === undefined ? {} : { last_activity_ms: lastActivity }),
    ...(id === 4
      ? {
          last_message: {
            id: 1,
            author: "mel",
            text: "latest note",
            kind: "text" as const,
            bot: false,
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
