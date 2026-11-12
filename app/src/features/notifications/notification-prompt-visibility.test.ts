import { describe, expect, it } from "vitest";
import {
  formatNotificationPromptVisibility,
  isIos,
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
  ])("hides when %s", (_name, changed) => {
    expect(shouldShowNotificationPrompt({ ...visible, ...changed })).toBe(
      false,
    );
  });

  it("formats every visibility condition for diagnostics", () => {
    expect(
      formatNotificationPromptVisibility({ ...visible, dismissed: undefined }),
    ).toBe(
      "configured=true / supported=true / permission=default / dismissed=pending / ios=false / display=browser / page=true",
    );
  });

  it("shows without Web Push when the page can post notifications", () => {
    expect(
      shouldShowNotificationPrompt({ ...visible, supported: false, ios: true }),
    ).toBe(true);
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
