import type { PushTarget as ApnsTarget } from "../native-bridge/generated/PushTarget";
import { readPushTarget } from "../native-bridge/page-events";
import type { WebPushTarget } from "./subscription";

/** Where the relay delivers a device's pushes: a browser subscription or an APNs token. */
export type DeviceTarget = WebPushTarget | ApnsTarget;

export function relayTargetBody(target: DeviceTarget): object {
  return isApnsTarget(target) ? target : { platform: "web_push", ...target };
}

export function sameDeviceTarget(
  current: DeviceTarget | undefined,
  next: DeviceTarget,
): boolean {
  if (current === undefined) return false;
  if (isApnsTarget(current) || isApnsTarget(next))
    return (
      isApnsTarget(current) &&
      isApnsTarget(next) &&
      current.token === next.token &&
      current.environment === next.environment
    );
  return (
    current.endpoint === next.endpoint &&
    current.p256dh === next.p256dh &&
    current.auth === next.auth
  );
}

export function isDeviceTarget(value: unknown): value is DeviceTarget {
  if (typeof value !== "object" || value === null) return false;
  if ("platform" in value) return readPushTarget(value) !== undefined;
  return (
    "endpoint" in value &&
    typeof value.endpoint === "string" &&
    "p256dh" in value &&
    typeof value.p256dh === "string" &&
    "auth" in value &&
    typeof value.auth === "string"
  );
}

function isApnsTarget(target: DeviceTarget): target is ApnsTarget {
  return "platform" in target;
}
