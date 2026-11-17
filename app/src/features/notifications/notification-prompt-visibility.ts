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
  /** This device's page notifications setting; undefined until the engine's settings load. */
  readonly pageNotificationsOn: boolean | undefined;
}

export type NotificationSwitchKind = "push" | "page";

type HostConditions = Pick<
  NotificationPromptVisibility,
  "configured" | "supported" | "ios" | "display" | "nativePush"
>;

/** Whether this host can receive push at all, before any permission or setting. */
export function canPushHere(conditions: HostConditions): boolean {
  return (
    conditions.configured &&
    (conditions.nativePush ||
      (conditions.supported &&
        (!conditions.ios || conditions.display === "standalone")))
  );
}

type SwitchConditions = HostConditions &
  Pick<NotificationPromptVisibility, "pageNotifications">;

/** The one notification switch this host offers: push where it works, else the page's own. */
export function notificationSwitchKind(
  conditions: SwitchConditions,
): NotificationSwitchKind | undefined {
  if (canPushHere(conditions)) return "push";
  return conditions.pageNotifications ? "page" : undefined;
}

/** An unloaded setting counts as off here, so a saved off is never overridden at launch. */
export function pageNotificationsSwitchedOn(
  conditions: SwitchConditions &
    Pick<NotificationPromptVisibility, "pageNotificationsOn">,
): boolean {
  return (
    notificationSwitchKind(conditions) !== "page" ||
    conditions.pageNotificationsOn === true
  );
}

export function shouldShowNotificationPrompt(
  conditions: NotificationPromptVisibility,
): boolean {
  return (
    conditions.permission === "default" &&
    conditions.dismissed === false &&
    promptFitsSwitch(conditions)
  );
}

function promptFitsSwitch(conditions: NotificationPromptVisibility): boolean {
  switch (notificationSwitchKind(conditions)) {
    case "push":
      return conditions.pushOnThisDevice !== false;
    case "page":
      return (
        conditions.configured &&
        !conditions.supported &&
        conditions.pageNotificationsOn !== false
      );
    case undefined:
      return false;
  }
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
    `push=${switchLabel(conditions.pushOnThisDevice)}`,
    `page_switch=${switchLabel(conditions.pageNotificationsOn)}`,
  ].join(" / ");
}

function switchLabel(on: boolean | undefined): string {
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
