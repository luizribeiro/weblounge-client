import { appearanceHintKey } from "../theme/appearance-hint";
import { deploymentConfigCacheKey } from "./deployment-config";
import {
  clientMinBuildReloadKey,
  clientResetTokenKey,
} from "./emergency-switch";
import { signedOutKey } from "./signed-out";

const appKey = /^weblounge[.:]/u;

/** Keys about this device or deployment rather than the member, which outlive a sign-out. */
const deviceKeys: ReadonlySet<string> = new Set([
  appearanceHintKey,
  deploymentConfigCacheKey,
  clientMinBuildReloadKey,
  clientResetTokenKey,
  signedOutKey,
]);
const deviceKeyPrefixes = ["weblounge.debug."];

function belongsToDevice(key: string): boolean {
  return (
    deviceKeys.has(key) ||
    deviceKeyPrefixes.some((prefix) => key.startsWith(prefix))
  );
}

/**
 * Removes every app key except the device's own, so state a feature adds later (drafts, image
 * sizes, the last viewed conversation) is forgotten on sign-out without being listed here.
 */
export function forgetMemberStorage(storage: Storage): void {
  try {
    const memberKeys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && appKey.test(key) && !belongsToDevice(key))
        memberKeys.push(key);
    }
    for (const key of memberKeys) storage.removeItem(key);
  } catch {
    // Storage the page can't reach holds nothing this sign-out could remove.
  }
}
