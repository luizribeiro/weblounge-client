import { describe, expect, it } from "vitest";
import {
  hasUnreadConversation,
  type TabIndicatorState,
  tabIndicator,
} from "./tab-indicator";

const connected: TabIndicatorState = {
  baseTitle: "weblounge",
  disconnected: false,
  showUnread: true,
  mentionCount: 0,
  hasUnread: false,
};

describe("tabIndicator", () => {
  it("keeps the brand icon and plain title while connected and read", () => {
    expect(tabIndicator(connected)).toEqual({
      icon: "connected",
      title: "weblounge",
    });
  });

  it("turns yellow for unread messages without counting them in the title", () => {
    expect(tabIndicator({ ...connected, hasUnread: true })).toEqual({
      icon: "unread",
      title: "weblounge",
    });
  });

  it("turns red and counts mentions in the title", () => {
    expect(tabIndicator({ ...connected, mentionCount: 3 })).toEqual({
      icon: "mention",
      title: "(3) weblounge",
    });
  });

  it("lets a mention win over other unread messages", () => {
    expect(
      tabIndicator({ ...connected, hasUnread: true, mentionCount: 2 }),
    ).toEqual({ icon: "mention", title: "(2) weblounge" });
  });

  it("caps the title count like the sidebar badge", () => {
    expect(tabIndicator({ ...connected, mentionCount: 120 }).title).toBe(
      "(99+) weblounge",
    );
  });

  it("turns grey while not connected", () => {
    expect(tabIndicator({ ...connected, disconnected: true })).toEqual({
      icon: "disconnected",
      title: "weblounge",
    });
  });

  it("lets a mention win over disconnected and disconnected over unread", () => {
    const offline = { ...connected, disconnected: true, hasUnread: true };
    expect(tabIndicator(offline)).toEqual({
      icon: "disconnected",
      title: "weblounge",
    });
    expect(tabIndicator({ ...offline, mentionCount: 1 })).toEqual({
      icon: "mention",
      title: "(1) weblounge",
    });
  });

  it("hides unread and mentions when the setting is off but still shows disconnected", () => {
    const off = {
      ...connected,
      showUnread: false,
      hasUnread: true,
      mentionCount: 5,
    };
    expect(tabIndicator(off)).toEqual({
      icon: "connected",
      title: "weblounge",
    });
    expect(tabIndicator({ ...off, disconnected: true })).toEqual({
      icon: "disconnected",
      title: "weblounge",
    });
  });
});

describe("hasUnreadConversation", () => {
  it("is false when every conversation is read", () => {
    expect(
      hasUnreadConversation([
        { kind: "channel", unread: 0 },
        { kind: "direct", unread: 0 },
      ]),
    ).toBe(false);
  });

  it("is true for an unread channel or direct message", () => {
    expect(
      hasUnreadConversation([
        { kind: "channel", unread: 0 },
        { kind: "channel", unread: 4 },
      ]),
    ).toBe(true);
    expect(hasUnreadConversation([{ kind: "direct", unread: 1 }])).toBe(true);
  });

  it("ignores server buffers, like the app badge", () => {
    expect(hasUnreadConversation([{ kind: "server", unread: 7 }])).toBe(false);
  });
});
