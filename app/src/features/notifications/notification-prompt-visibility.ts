import type { DisplayMode } from "../../platform/environment";

export interface NotificationPromptVisibility {
  readonly configured: boolean;
  readonly supported: boolean;
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
    conditions.supported &&
    conditions.permission === "default" &&
    conditions.dismissed === false &&
    (!conditions.ios || conditions.display === "standalone")
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
  ].join(" / ");
}

export function supportsWebPush(
  browserWindow: Window,
  browserNavigator: Navigator,
): boolean {
  return (
    "Notification" in browserWindow &&
    "PushManager" in browserWindow &&
    "serviceWorker" in browserNavigator
  );
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
