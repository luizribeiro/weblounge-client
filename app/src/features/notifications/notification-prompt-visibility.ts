import type { DisplayMode } from "../../platform/environment";

export interface NotificationPromptVisibility {
  readonly configured: boolean;
  readonly supported: boolean;
  readonly pageNotifications: boolean;
  readonly permission: NotificationPermission;
  readonly dismissed: boolean | undefined;
  readonly ios: boolean;
  readonly display: DisplayMode;
}

export function shouldShowNotificationPrompt(
  conditions: NotificationPromptVisibility,
): boolean {
  return (
    conditions.configured &&
    conditions.permission === "default" &&
    conditions.dismissed === false &&
    (conditions.supported
      ? !conditions.ios || conditions.display === "standalone"
      : conditions.pageNotifications)
  );
}

export function formatNotificationPromptVisibility(
  conditions: NotificationPromptVisibility,
): string {
  return [
    `configured=${conditions.configured}`,
    `supported=${conditions.supported}`,
    `permission=${conditions.permission}`,
    `dismissed=${conditions.dismissed ?? "pending"}`,
    `ios=${conditions.ios}`,
    `display=${conditions.display}`,
    `page=${conditions.pageNotifications}`,
  ].join(" / ");
}

export function supportsWebPush(
  browserWindow: Window,
  browserNavigator: Navigator,
): boolean {
  return (
    supportsPageNotifications(browserWindow) &&
    "PushManager" in browserWindow &&
    "serviceWorker" in browserNavigator
  );
}

export function supportsPageNotifications(browserWindow: Window): boolean {
  return "Notification" in browserWindow;
}

export function isIos(
  browserNavigator: Pick<
    Navigator,
    "maxTouchPoints" | "platform" | "userAgent"
  >,
): boolean {
  return (
    /iPad|iPhone|iPod/u.test(
      `${browserNavigator.platform} ${browserNavigator.userAgent}`,
    ) ||
    (browserNavigator.platform === "MacIntel" &&
      browserNavigator.maxTouchPoints > 1)
  );
}
