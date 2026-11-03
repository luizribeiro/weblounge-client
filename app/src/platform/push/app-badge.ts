import type { BufferProjection } from "../../engine/protocol";
import { writeAppBadgeCount } from "./push-database";

interface BadgeNavigator {
  setAppBadge?(contents?: number): Promise<void>;
  clearAppBadge?(): Promise<void>;
}

export function appBadgeCount(buffers: readonly BufferProjection[]): number {
  return buffers.reduce(
    (count, buffer) =>
      count + (buffer.kind === "direct" ? buffer.unread : buffer.mentions),
    0,
  );
}

export async function syncAppBadge(
  buffers: readonly BufferProjection[],
  badgeNavigator: BadgeNavigator = navigator,
): Promise<void> {
  const count = appBadgeCount(buffers);
  if (count === 0) {
    if (badgeNavigator.clearAppBadge === undefined) return;
    await Promise.all([writeAppBadgeCount(0), badgeNavigator.clearAppBadge()]);
    return;
  }
  if (badgeNavigator.setAppBadge === undefined) return;
  await Promise.all([
    writeAppBadgeCount(count),
    badgeNavigator.setAppBadge(count),
  ]);
}
