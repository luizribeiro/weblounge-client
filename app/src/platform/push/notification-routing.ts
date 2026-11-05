import {
  type PendingOpenRouteIntent,
  recordPendingOpenRoute,
} from "./pending-open-route";

interface WindowClientLike {
  focus(): Promise<WindowClientLike>;
  navigate(url: string): Promise<WindowClientLike | null>;
  postMessage(message: unknown): void;
}

export interface NotificationClients {
  matchAll(options: {
    readonly type: "window";
    readonly includeUncontrolled: true;
  }): Promise<readonly WindowClientLike[]>;
  openWindow(url: string): Promise<WindowClientLike | null>;
}

export interface ClickedNotification {
  readonly data?: unknown;
  close(): void;
}

export async function routeNotificationClick(
  clients: NotificationClients,
  notification: ClickedNotification,
  recordIntent: (
    route: string,
  ) => Promise<PendingOpenRouteIntent> = recordPendingOpenRoute,
): Promise<void> {
  notification.close();
  const route = notificationRoute(notification.data);
  const intent = await recordIntent(route).catch(() => undefined);
  const windows = await clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const existing = windows[0];
  if (existing === undefined) {
    await clients.openWindow(route);
    return;
  }
  try {
    const focused = await existing.focus();
    focused.postMessage({
      kind: "open-route",
      route,
      ...(intent === undefined ? {} : { intentId: intent.id }),
    });
  } catch {
    try {
      const navigated = await existing.navigate(route);
      if (navigated !== null) return;
    } catch {}
    await clients.openWindow(route);
  }
}

function notificationRoute(data: unknown): string {
  if (
    typeof data === "object" &&
    data !== null &&
    "route" in data &&
    typeof data.route === "string" &&
    data.route.startsWith("/")
  ) {
    return data.route;
  }
  return "/";
}
