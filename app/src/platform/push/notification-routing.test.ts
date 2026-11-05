import { describe, expect, it, vi } from "vitest";
import {
  type NotificationClients,
  routeNotificationClick,
} from "./notification-routing";

describe("notification click routing", () => {
  it("records before focusing a suspended client whose message may be lost", async () => {
    const events: string[] = [];
    const postMessage = vi.fn();
    const focused = {
      focus: vi.fn(),
      navigate: vi.fn(),
      postMessage,
    };
    const windowClient = {
      focus: vi.fn(async () => {
        events.push("focus");
        return focused;
      }),
      navigate: vi.fn(),
      postMessage: vi.fn(),
    };
    const clients = {
      matchAll: vi.fn(async () => [windowClient]),
      openWindow: vi.fn(),
    } as unknown as NotificationClients;
    const notification = {
      data: { route: "/Lounge/@mel" },
      close: vi.fn(),
    };
    const record = vi.fn(async () => {
      events.push("record");
      return { id: "intent-1", route: "/Lounge/@mel" };
    });

    await routeNotificationClick(clients, notification, record);

    expect(notification.close).toHaveBeenCalledOnce();
    expect(events).toEqual(["record", "focus"]);
    expect(windowClient.focus).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({
      kind: "open-route",
      route: "/Lounge/@mel",
      intentId: "intent-1",
    });
    expect(clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens a cold deep link when no client exists", async () => {
    const clients = {
      matchAll: vi.fn(async () => []),
      openWindow: vi.fn(async () => null),
    } as unknown as NotificationClients;
    const notification = {
      data: { route: "/Lounge/lounge" },
      close: vi.fn(),
    };
    const record = vi.fn(async () => ({
      id: "intent-2",
      route: "/Lounge/lounge",
    }));

    await routeNotificationClick(clients, notification, record);

    expect(record).toHaveBeenCalledWith("/Lounge/lounge");
    expect(clients.openWindow).toHaveBeenCalledWith("/Lounge/lounge");
  });

  it("navigates an existing client when iOS rejects focus", async () => {
    const windowClient = {
      focus: vi.fn(async () => Promise.reject(new Error("not allowed"))),
      navigate: vi.fn(async () => windowClient),
      postMessage: vi.fn(),
    };
    const clients = {
      matchAll: vi.fn(async () => [windowClient]),
      openWindow: vi.fn(),
    } as unknown as NotificationClients;

    await routeNotificationClick(
      clients,
      { data: { route: "/Lounge/@mel" }, close: vi.fn() },
      async () => ({ id: "intent-3", route: "/Lounge/@mel" }),
    );

    expect(windowClient.navigate).toHaveBeenCalledWith("/Lounge/@mel");
    expect(windowClient.postMessage).not.toHaveBeenCalled();
    expect(clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens a new window when focus and navigation both fail", async () => {
    const windowClient = {
      focus: vi.fn(async () => Promise.reject(new Error("not allowed"))),
      navigate: vi.fn(async () => Promise.reject(new Error("discarded"))),
      postMessage: vi.fn(),
    };
    const clients = {
      matchAll: vi.fn(async () => [windowClient]),
      openWindow: vi.fn(async () => null),
    } as unknown as NotificationClients;

    await routeNotificationClick(
      clients,
      { data: { route: "/Lounge/@mel" }, close: vi.fn() },
      async () => ({ id: "intent-4", route: "/Lounge/@mel" }),
    );

    expect(clients.openWindow).toHaveBeenCalledWith("/Lounge/@mel");
  });
});
