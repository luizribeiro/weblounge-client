import { describe, expect, it } from "vitest";
import {
  canPushHere,
  formatNotificationPromptVisibility,
  isIos,
  notificationSwitchKind,
  shouldShowNotificationPrompt,
} from "./notification-prompt-visibility";

const visible = {
  configured: true,
  supported: true,
  pageNotifications: true,
  permission: "default" as const,
  dismissed: false,
  ios: false,
  display: "browser" as const,
  nativePush: false,
  pushOnThisDevice: true,
  pageNotificationsOn: true,
};

describe("notification prompt visibility", () => {
  it("shows when every prerequisite is met", () => {
    expect(shouldShowNotificationPrompt(visible)).toBe(true);
  });

  it.each([
    ["push is not configured", { configured: false }],
    [
      "neither Web Push nor page notifications exist",
      { supported: false, pageNotifications: false },
    ],
    ["permission was granted", { permission: "granted" as const }],
    ["permission was denied", { permission: "denied" as const }],
    ["the device dismissed it", { dismissed: true }],
    ["the dismissal read is pending", { dismissed: undefined }],
    ["iOS is running in a browser", { ios: true }],
    ["push was turned off on this device", { pushOnThisDevice: false }],
    [
      "page notifications were turned off where only the page can notify",
      { supported: false, pageNotificationsOn: false },
    ],
  ])("hides when %s", (_name, changed) => {
    expect(shouldShowNotificationPrompt({ ...visible, ...changed })).toBe(
      false,
    );
  });

  it("formats every visibility condition for diagnostics", () => {
    expect(
      formatNotificationPromptVisibility({ ...visible, dismissed: undefined }),
    ).toBe(
      "configured=true / supported=true / permission=default / dismissed=pending / ios=false / display=browser / page=true / native=false / push=on / page_switch=on",
    );
  });

  it("shows before the push setting loads, since the default is on", () => {
    expect(
      shouldShowNotificationPrompt({ ...visible, pushOnThisDevice: undefined }),
    ).toBe(true);
  });

  it("knows where this host can push, whatever the permission", () => {
    expect(canPushHere(visible)).toBe(true);
    expect(canPushHere({ ...visible, configured: false })).toBe(false);
    expect(canPushHere({ ...visible, supported: false })).toBe(false);
    expect(canPushHere({ ...visible, ios: true })).toBe(false);
    expect(canPushHere({ ...visible, ios: true, display: "standalone" })).toBe(
      true,
    );
    expect(
      canPushHere({
        ...visible,
        supported: false,
        ios: true,
        display: "tauri",
        nativePush: true,
      }),
    ).toBe(true);
  });

  it("shows without Web Push when the page can post notifications", () => {
    expect(
      shouldShowNotificationPrompt({ ...visible, supported: false, ios: true }),
    ).toBe(true);
  });

  it("follows only the switch that applies to this host", () => {
    expect(
      shouldShowNotificationPrompt({ ...visible, pageNotificationsOn: false }),
    ).toBe(true);
    expect(
      shouldShowNotificationPrompt({
        ...visible,
        supported: false,
        pushOnThisDevice: false,
      }),
    ).toBe(true);
  });

  it("offers push where it works, else the page's switch, else none", () => {
    expect(notificationSwitchKind(visible)).toBe("push");
    expect(notificationSwitchKind({ ...visible, supported: false })).toBe(
      "page",
    );
    expect(notificationSwitchKind({ ...visible, configured: false })).toBe(
      "page",
    );
    expect(
      notificationSwitchKind({
        ...visible,
        supported: false,
        pageNotifications: false,
      }),
    ).toBeUndefined();
  });

  it("shows in an installed iOS home-screen app", () => {
    expect(
      shouldShowNotificationPrompt({
        ...visible,
        ios: true,
        display: "standalone",
      }),
    ).toBe(true);
  });

  it("shows in the iPhone app, whose shell registers push itself", () => {
    const iphoneApp = {
      ...visible,
      supported: true,
      pageNotifications: false,
      ios: true,
      display: "tauri" as const,
      nativePush: true,
    };

    expect(shouldShowNotificationPrompt(iphoneApp)).toBe(true);
    expect(
      shouldShowNotificationPrompt({ ...iphoneApp, permission: "granted" }),
    ).toBe(false);
    expect(
      shouldShowNotificationPrompt({ ...iphoneApp, permission: "denied" }),
    ).toBe(false);
    expect(
      shouldShowNotificationPrompt({ ...iphoneApp, nativePush: false }),
    ).toBe(false);
  });

  it("recognizes iPhone, iPad, and touch-capable iPadOS desktop identity", () => {
    expect(
      isIos({ platform: "iPhone", maxTouchPoints: 5, userAgent: "Mobile" }),
    ).toBe(true);
    expect(
      isIos({ platform: "iPad", maxTouchPoints: 5, userAgent: "Mobile" }),
    ).toBe(true);
    expect(
      isIos({ platform: "MacIntel", maxTouchPoints: 5, userAgent: "Safari" }),
    ).toBe(true);
    expect(
      isIos({
        platform: "MacIntel",
        maxTouchPoints: 0,
        userAgent: "iPhone Mobile",
      }),
    ).toBe(true);
    expect(
      isIos({ platform: "MacIntel", maxTouchPoints: 0, userAgent: "Safari" }),
    ).toBe(false);
    expect(
      isIos({
        platform: "Linux armv8l",
        maxTouchPoints: 5,
        userAgent: "Android",
      }),
    ).toBe(false);
  });
});
