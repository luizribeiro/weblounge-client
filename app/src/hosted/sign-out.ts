import {
  clearAppPushState,
  type NotificationCenter,
} from "../platform/push/app-badge";
import { forgetMemberStorage } from "./member-storage";
import { markSignedOut } from "./signed-out";

export interface SignOutDevice {
  /** Signs push out, then ends the hosted connection and drops the engine's chat caches. */
  readonly endSession: () => Promise<void>;
  readonly notifications: NotificationCenter;
  readonly deviceStorage: Storage;
  readonly sessionStorage: Storage;
}

/** How long the session and notifications may take before the device signs out regardless. */
export const signOutDeadlineMs = 5_000;

/** Leaves nothing of the member's chats on this device and keeps it from signing back in. */
export async function signOutDevice(device: SignOutDevice): Promise<void> {
  // Marked before the session ends: other tabs see it end and must find the device signed out.
  markSignedOut(device.deviceStorage);
  await settleWithin(signOutDeadlineMs, [
    device.endSession(),
    clearAppPushState(device.notifications),
  ]);
  // Last, so nothing the page writes while the session ends survives the sign-out.
  forgetMemberStorage(device.deviceStorage);
  forgetMemberStorage(device.sessionStorage);
}

async function settleWithin(
  milliseconds: number,
  work: readonly Promise<unknown>[],
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    // wait-ok: a fixed upper bound so a stuck engine or relay can't keep the device signed in.
    timer = setTimeout(resolve, milliseconds);
  });
  await Promise.race([Promise.allSettled(work), deadline]);
  clearTimeout(timer);
}
