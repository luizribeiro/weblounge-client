import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import type { MessageProjection } from "../../engine/generated/MessageProjection";
import { createReplyDrafts } from "./reply-drafts";

const parent: MessageProjection = {
  id: 12,
  author: "bruno",
  text: "does the relay see plaintext?",
  kind: "text",
  bot: null,
  authorship: "other",
  nick_color_index: 6,
  highlighted: false,
  delivery: "received",
  local_send_id: null,
  server_ids: ["parent-12"],
  server_time_ms: 1_000,
  received_at_ms: 1_000,
};

describe("createReplyDrafts", () => {
  it("keeps one reply per conversation until it is cancelled", () => {
    createRoot((dispose) => {
      const drafts = createReplyDrafts();
      drafts.start(1, parent);
      drafts.start(2, { ...parent, id: 13, author: "ana", text: "same" });
      drafts.start(1, { ...parent, id: 14, text: "replaced" });

      expect(drafts.draft(1)).toEqual({
        messageId: 14,
        author: "bruno",
        nickColorIndex: 6,
        text: "replaced",
      });
      expect(drafts.draft(2)?.messageId).toBe(13);
      const answered = drafts.draft(1);
      drafts.start(1, { ...parent, id: 14, text: "replaced" });
      if (answered !== undefined) drafts.cancel(1, answered);
      expect(drafts.draft(1)?.messageId).toBe(14);
      const current = drafts.draft(1);
      if (current !== undefined) drafts.cancel(1, current);
      expect(drafts.draft(1)).toBeUndefined();
      expect(drafts.draft(2)?.author).toBe("ana");
      dispose();
    });
  });
});
