import { describe, expect, it } from "vitest";
import { type TabIndicatorState, tabIndicator } from "./tab-indicator";

const connected: TabIndicatorState = {
  baseTitle: "weblounge",
  disconnected: false,
  showUnread: true,
  unreadCount: 0,
};

describe("tabIndicator", () => {
  it("keeps the brand icon and plain title while connected and read", () => {
    expect(tabIndicator(connected)).toEqual({
      icon: "connected",
      title: "weblounge",
    });
  });

  it("turns red and counts unread in the title", () => {
    expect(tabIndicator({ ...connected, unreadCount: 3 })).toEqual({
      icon: "unread",
      title: "(3) weblounge",
    });
  });

  it("caps the title count like the sidebar badge", () => {
    expect(tabIndicator({ ...connected, unreadCount: 120 }).title).toBe(
      "(99+) weblounge",
    );
  });

  it("turns grey while not connected", () => {
    expect(tabIndicator({ ...connected, disconnected: true })).toEqual({
      icon: "disconnected",
      title: "weblounge",
    });
  });

  it("lets unread win over disconnected", () => {
    expect(
      tabIndicator({ ...connected, disconnected: true, unreadCount: 1 }),
    ).toEqual({ icon: "unread", title: "(1) weblounge" });
  });

  it("hides unread when the setting is off but still shows disconnected", () => {
    const off = { ...connected, showUnread: false, unreadCount: 5 };
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
