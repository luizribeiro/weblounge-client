type MarkerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const signedOutKey = "weblounge.account.signed-out";

/**
 * The members' session outlives a sign-out here (concierge has no sign-out endpoint the app may
 * call), so this device remembers the choice and stops signing itself back in on launch.
 */
export function markSignedOut(storage: MarkerStorage = localStorage): void {
  try {
    storage.setItem(signedOutKey, "true");
  } catch {
    // Without storage the next launch signs in again, as it did before signing out.
  }
}

export function isSignedOut(storage: MarkerStorage = localStorage): boolean {
  try {
    return storage.getItem(signedOutKey) === "true";
  } catch {
    return false;
  }
}

export function clearSignedOut(storage: MarkerStorage = localStorage): void {
  try {
    storage.removeItem(signedOutKey);
  } catch {
    // A marker we can't read can't keep the device signed out either.
  }
}
