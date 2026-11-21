import type { PeerPresence } from "../../engine/protocol";
import { t } from "../../strings";
import { formatTimeOrDate } from "../../ui/format-time";

/** A DM peer's status line; the time appears only when the engine saw the change happen. */
export function presenceStatus(
  presence: PeerPresence,
  sinceMs: number | undefined,
  now?: number,
): string {
  if (presence === "online" || sinceMs === undefined)
    return t(`conversation.presence.${presence}`);
  return t(`conversation.presence.${presence}_since`, {
    time: formatTimeOrDate(sinceMs, now),
  });
}
