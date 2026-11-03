import type { DisplayMode } from "../../platform/environment";

interface NotificationPromptVisibility {
  readonly configured: boolean;
  readonly supported: boolean;
  readonly permission: NotificationPermission;
  readonly dismissed: boolean;
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
    !conditions.dismissed &&
    (!conditions.ios || conditions.display === "standalone")
  );
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
