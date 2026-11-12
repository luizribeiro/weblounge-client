import { describe, expect, it } from "vitest";
import {
  type PagePostConditions,
  type PushDeliveryConditions,
  pushDeliveryFor,
  shouldPostPageNotification,
} from "./page-notification-policy";

const enabledPush: PushDeliveryConditions = {
  webPushSupported: true,
  pushConfigured: true,
  permission: "granted",
  subscription: "ready",
  registration: { status: "registered", route_id: "route-7f3a" },
};

const macWrapperPage: PagePostConditions = {
  pageNotificationsSupported: true,
  permission: "granted",
  pushDelivery: "unavailable",
  postingTab: true,
  pageForeground: false,
  bufferShown: false,
};

describe("pushDeliveryFor", () => {
  it("is active once this device's route is registered", () => {
    expect(pushDeliveryFor(enabledPush)).toBe("active");
  });

  it("is unavailable without the Web Push capability, as in WKWebView", () => {
    expect(
      pushDeliveryFor({
        ...enabledPush,
        webPushSupported: false,
        subscription: "pending",
        registration: undefined,
      }),
    ).toBe("unavailable");
  });

  it("is unavailable when push isn't configured or permitted", () => {
    expect(pushDeliveryFor({ ...enabledPush, pushConfigured: false })).toBe(
      "unavailable",
    );
    expect(pushDeliveryFor({ ...enabledPush, permission: "default" })).toBe(
      "unavailable",
    );
    expect(
      pushDeliveryFor({ ...enabledPush, subscription: "unavailable" }),
    ).toBe("unavailable");
  });

  it("stays pending while the subscription or registration is in flight", () => {
    expect(pushDeliveryFor({ ...enabledPush, subscription: "pending" })).toBe(
      "pending",
    );
    expect(pushDeliveryFor({ ...enabledPush, registration: undefined })).toBe(
      "pending",
    );
  });

  it("is unavailable when the home can't deliver to this route", () => {
    for (const registration of [
      { status: "registered_but_no_delivery", route_id: "route-7f3a" },
      { status: "unsupported", reason: "no_web_push" },
      { status: "failed", route_id: "route-7f3a", reason: "internal" },
    ] as const) {
      expect(pushDeliveryFor({ ...enabledPush, registration })).toBe(
        "unavailable",
      );
    }
  });
});

describe("shouldPostPageNotification", () => {
  it("posts for a hidden page when push can't deliver", () => {
    expect(shouldPostPageNotification(macWrapperPage)).toBe(true);
  });

  it("posts for a buffer the foreground page isn't showing", () => {
    expect(
      shouldPostPageNotification({ ...macWrapperPage, pageForeground: true }),
    ).toBe(true);
  });

  it("posts for the shown buffer once the page loses the foreground", () => {
    expect(
      shouldPostPageNotification({ ...macWrapperPage, bufferShown: true }),
    ).toBe(true);
  });

  it("never posts for the buffer on screen", () => {
    expect(
      shouldPostPageNotification({
        ...macWrapperPage,
        pageForeground: true,
        bufferShown: true,
      }),
    ).toBe(false);
  });

  it("leaves delivery to push whenever push is active or still pending", () => {
    expect(
      shouldPostPageNotification({ ...macWrapperPage, pushDelivery: "active" }),
    ).toBe(false);
    expect(
      shouldPostPageNotification({
        ...macWrapperPage,
        pushDelivery: "pending",
      }),
    ).toBe(false);
  });

  it("needs the Notification API, permission and the posting tab", () => {
    expect(
      shouldPostPageNotification({
        ...macWrapperPage,
        pageNotificationsSupported: false,
      }),
    ).toBe(false);
    expect(
      shouldPostPageNotification({ ...macWrapperPage, permission: "denied" }),
    ).toBe(false);
    expect(
      shouldPostPageNotification({ ...macWrapperPage, postingTab: false }),
    ).toBe(false);
  });
});
