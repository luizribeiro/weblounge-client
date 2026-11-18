import type { BufferProjection } from "../../engine/protocol";
import { badgeCountLabel } from "./unread-badge";

export type TabIcon = "connected" | "unread" | "mention" | "disconnected";

export interface TabIndicator {
  readonly icon: TabIcon;
  readonly title: string;
}

export interface TabIndicatorState {
  readonly baseTitle: string;
  readonly disconnected: boolean;
  readonly showUnread: boolean;
  readonly mentionCount: number;
  readonly hasUnread: boolean;
}

export function tabIndicator(state: TabIndicatorState): TabIndicator {
  if (state.showUnread && state.mentionCount > 0) {
    return {
      icon: "mention",
      title: `(${badgeCountLabel(state.mentionCount)}) ${state.baseTitle}`,
    };
  }
  return { icon: quietTabIcon(state), title: state.baseTitle };
}

export function hasUnreadConversation(
  buffers: readonly Pick<BufferProjection, "kind" | "unread">[],
): boolean {
  return buffers.some(
    (buffer) => buffer.kind !== "server" && buffer.unread > 0,
  );
}

function quietTabIcon(state: TabIndicatorState): TabIcon {
  if (state.disconnected) return "disconnected";
  return state.showUnread && state.hasUnread ? "unread" : "connected";
}
