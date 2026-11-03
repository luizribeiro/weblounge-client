import { expect, it } from "vitest";
import type { BufferProjection } from "../../engine/protocol";
import { appBadgeCount } from "./app-badge";

it("counts unread direct messages once plus channel mentions", () => {
  expect(
    appBadgeCount([
      buffer({ kind: "direct", unread: 4, mentions: 4 }),
      buffer({ kind: "channel", unread: 12, mentions: 2 }),
      buffer({ kind: "server", unread: 3, mentions: 0 }),
    ]),
  ).toBe(6);
});

function buffer(
  projection: Pick<BufferProjection, "kind" | "unread" | "mentions">,
): BufferProjection {
  return {
    id: 1,
    network_id: 1,
    title: "buffer",
    draft_key: "draft",
    topic: null,
    read_through: null,
    ...projection,
  };
}
