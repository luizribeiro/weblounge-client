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
}

export function tabIndicator(state: TabIndicatorState): TabIndicator {
  if (state.showUnread && state.mentionCount > 0) {
    return {
      icon: "mention",
      title: `(${badgeCountLabel(state.mentionCount)}) ${state.baseTitle}`,
    };
  }
  return {
    icon: state.disconnected ? "disconnected" : "connected",
    title: state.baseTitle,
  };
}
