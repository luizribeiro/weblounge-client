import type { BufferProjection } from "../../engine/protocol";
import { t } from "../../strings";

export interface UnreadBadge {
  readonly count: string;
  readonly kind: "mention" | "unread";
  readonly label: string;
}

export function unreadBadge(
  buffer: Pick<BufferProjection, "mentions" | "unread">,
): UnreadBadge | undefined {
  if (buffer.unread === 0) return undefined;
  const includesMentions = buffer.mentions > 0;
  const count = buffer.unread > 99 ? "99+" : String(buffer.unread);
  return {
    count,
    kind: includesMentions ? "mention" : "unread",
    label: t(includesMentions ? "sidebar.unread_mentions" : "sidebar.unread", {
      count,
    }),
  };
}
