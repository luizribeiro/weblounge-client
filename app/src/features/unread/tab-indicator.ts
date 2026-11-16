import { badgeCountLabel } from "./unread-badge";

export type TabIcon = "connected" | "unread" | "disconnected";

export interface TabIndicator {
  readonly icon: TabIcon;
  readonly title: string;
}

export interface TabIndicatorState {
  readonly baseTitle: string;
  readonly disconnected: boolean;
  readonly showUnread: boolean;
  readonly unreadCount: number;
}

export function tabIndicator(state: TabIndicatorState): TabIndicator {
  if (state.showUnread && state.unreadCount > 0) {
    return {
      icon: "unread",
      title: `(${badgeCountLabel(state.unreadCount)}) ${state.baseTitle}`,
    };
  }
  return {
    icon: state.disconnected ? "disconnected" : "connected",
    title: state.baseTitle,
  };
}
