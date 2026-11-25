import { createSignal } from "solid-js";
import type { MessageId } from "../../engine/generated/MessageId";
import type { MessageProjection } from "../../engine/generated/MessageProjection";

/** The message a conversation's composer is replying to, as its bar shows it. */
export interface ReplyDraft {
  readonly messageId: MessageId;
  readonly author: string;
  readonly nickColorIndex: number;
  readonly text: string;
}

export interface ReplyDrafts {
  readonly draft: (bufferId: number) => ReplyDraft | undefined;
  readonly start: (bufferId: number, message: MessageProjection) => void;
  /** Drops the conversation's reply only while it is still `draft`, so a late send can't drop a newer one. */
  readonly cancel: (bufferId: number, draft: ReplyDraft) => void;
}

/** One reply at a time per conversation; switching away keeps it for coming back. */
export function createReplyDrafts(): ReplyDrafts {
  const [drafts, setDrafts] = createSignal<ReadonlyMap<number, ReplyDraft>>(
    new Map(),
  );
  const update = (bufferId: number, draft: ReplyDraft | undefined) =>
    setDrafts((current) => {
      const next = new Map(current);
      if (draft === undefined) next.delete(bufferId);
      else next.set(bufferId, draft);
      return next;
    });
  return {
    draft: (bufferId) => drafts().get(bufferId),
    start: (bufferId, message) =>
      update(bufferId, {
        messageId: message.id,
        author: message.author,
        nickColorIndex: message.nick_color_index,
        text: message.text,
      }),
    cancel: (bufferId, draft) => {
      if (drafts().get(bufferId) === draft) update(bufferId, undefined);
    },
  };
}
