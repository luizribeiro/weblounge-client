import type { BufferProjection } from "../../engine/protocol";
import { t } from "../../strings";

export interface UnreadBadge {
  readonly count: number;
  readonly kind: "mention" | "unread";
  readonly label: string;
}

export function unreadBadge(
  buffer: Pick<BufferProjection, "mentions" | "unread">,
): UnreadBadge | undefined {
  if (buffer.unread === 0) return undefined;
  const includesMentions = buffer.mentions > 0;
  return {
    count: buffer.unread,
    kind: includesMentions ? "mention" : "unread",
    label: t(includesMentions ? "sidebar.unread_mentions" : "sidebar.unread", {
      count: String(buffer.unread),
    }),
  };
}
