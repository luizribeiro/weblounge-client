import type { DisplayMode } from "../../platform/environment";

export interface NotificationPromptVisibility {
  readonly configured: boolean;
  readonly supported: boolean;
  readonly pageNotifications: boolean;
  readonly permission: NotificationPermission;
  readonly dismissed: boolean | undefined;
  readonly ios: boolean;
  readonly display: DisplayMode;
  readonly nativePush: boolean;
  /** This device's push setting; undefined until the engine's settings load. */
  readonly pushOnThisDevice: boolean | undefined;
}

/** Whether this host can receive push at all, before any permission or setting. */
export function canPushHere(
  conditions: Pick<
    NotificationPromptVisibility,
    "configured" | "supported" | "ios" | "display" | "nativePush"
  >,
): boolean {
  return (
    conditions.configured &&
    (conditions.nativePush ||
      (conditions.supported &&
        (!conditions.ios || conditions.display === "standalone")))
  );
}

export function shouldShowNotificationPrompt(
  conditions: NotificationPromptVisibility,
): boolean {
  return (
    conditions.permission === "default" &&
    conditions.dismissed === false &&
    conditions.pushOnThisDevice !== false &&
    (canPushHere(conditions) ||
      (conditions.configured &&
        !conditions.supported &&
        conditions.pageNotifications))
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
    `native=${conditions.nativePush}`,
    `push=${pushSettingLabel(conditions.pushOnThisDevice)}`,
  ].join(" / ");
}

function pushSettingLabel(on: boolean | undefined): string {
  if (on === undefined) return "pending";
  return on ? "on" : "off";
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
