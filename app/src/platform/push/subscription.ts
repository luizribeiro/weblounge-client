import { decodeBase64Url, encodeBase64Url } from "./base64url";

export interface WebPushTarget {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export type SubscriptionResult =
  | { readonly status: "ready"; readonly target: WebPushTarget }
  | { readonly status: "permission_not_granted" }
  | { readonly status: "unavailable" };

export async function ensurePushSubscription(
  registration: ServiceWorkerRegistration,
  relayVapid: string,
  permission: NotificationPermission = Notification.permission,
): Promise<SubscriptionResult> {
  if (permission !== "granted") return { status: "permission_not_granted" };
  if (!("pushManager" in registration)) return { status: "unavailable" };

  const applicationServerKey = decodeBase64Url(relayVapid);
  let subscription = await registration.pushManager.getSubscription();
  if (
    subscription !== null &&
    !sameBytes(subscription.options.applicationServerKey, applicationServerKey)
  ) {
    if (!(await subscription.unsubscribe())) return { status: "unavailable" };
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    applicationServerKey,
    userVisibleOnly: true,
  });
  const p256dh = subscription.getKey("p256dh");
  const auth = subscription.getKey("auth");
  if (p256dh === null || auth === null) return { status: "unavailable" };
  return {
    status: "ready",
    target: {
      endpoint: subscription.endpoint,
      p256dh: encodeBase64Url(p256dh),
      auth: encodeBase64Url(auth),
    },
  };
}

function sameBytes(current: ArrayBuffer | null, expected: Uint8Array): boolean {
  if (current === null || current.byteLength !== expected.byteLength)
    return false;
  const actual = new Uint8Array(current);
  return actual.every((byte, index) => byte === expected[index]);
}
