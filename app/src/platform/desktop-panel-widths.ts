import { sidebarWidth } from "../features/sidebar/sidebar-width";

export const memberColumnWidth = 232;
export const minConversationWidth = 480;
export const desktopPanelBoundary = sidebarWidth + minConversationWidth;
export const membersInlinePaneWidth = memberColumnWidth + minConversationWidth;
export const membersDockedWindowWidth = sidebarWidth + membersInlinePaneWidth;
