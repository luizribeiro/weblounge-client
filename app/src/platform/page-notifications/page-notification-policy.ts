import type { PushState } from "../../engine/generated/PushState";

export type PushSubscriptionStatus = "pending" | "ready" | "unavailable";

export type PushDelivery = "active" | "pending" | "unavailable";

export interface PushDeliveryConditions {
  readonly webPushSupported: boolean;
  readonly pushConfigured: boolean;
  readonly permission: NotificationPermission;
  readonly subscription: PushSubscriptionStatus;
  readonly registration: PushState | undefined;
}

export interface PagePostConditions {
  readonly pageNotificationsSupported: boolean;
  readonly permission: NotificationPermission;
  readonly pushDelivery: PushDelivery;
  readonly postingTab: boolean;
  readonly pageForeground: boolean;
  readonly bufferShown: boolean;
}

export function pushDeliveryFor(
  conditions: PushDeliveryConditions,
): PushDelivery {
  if (
    !conditions.webPushSupported ||
    !conditions.pushConfigured ||
    conditions.permission !== "granted" ||
    conditions.subscription === "unavailable"
  ) {
    return "unavailable";
  }
  if (conditions.subscription === "pending") return "pending";
  return registrationDelivery(conditions.registration);
}

export function shouldPostPageNotification(
  conditions: PagePostConditions,
): boolean {
  return (
    conditions.pageNotificationsSupported &&
    conditions.permission === "granted" &&
    conditions.pushDelivery === "unavailable" &&
    conditions.postingTab &&
    !(conditions.pageForeground && conditions.bufferShown)
  );
}

function registrationDelivery(registration: PushState | undefined) {
  if (registration === undefined) return "pending";
  switch (registration.status) {
    case "registered":
      return "active";
    case "registered_but_no_delivery":
    case "unsupported":
    case "failed":
      return "unavailable";
  }
}
