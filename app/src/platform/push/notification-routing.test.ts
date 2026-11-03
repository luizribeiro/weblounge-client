import { describe, expect, it, vi } from "vitest";
import {
  type NotificationClients,
  routeNotificationClick,
} from "./notification-routing";

describe("notification click routing", () => {
  it("focuses an existing client and asks it to open the route", async () => {
    const postMessage = vi.fn();
    const focused = { focus: vi.fn(), postMessage };
    const windowClient = {
      focus: vi.fn(async () => focused),
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

    await routeNotificationClick(clients, notification);

    expect(notification.close).toHaveBeenCalledOnce();
    expect(windowClient.focus).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({
      kind: "open-route",
      route: "/Lounge/@mel",
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

    await routeNotificationClick(clients, notification);

    expect(clients.openWindow).toHaveBeenCalledWith("/Lounge/lounge");
  });
});
