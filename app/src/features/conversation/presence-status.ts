import type { PeerPresence } from "../../engine/protocol";
import { t } from "../../strings";
import {
  calendarDaysBefore,
  formatMonthYear,
  formatShortDate,
  formatTime,
  formatWeekday,
  isSameLocalYear,
} from "../../ui/format-time";

/** A DM peer's status line; the time appears only when the engine saw the change happen. */
export function presenceStatus(
  presence: PeerPresence,
  sinceMs: number | undefined,
  now = Date.now(),
): string {
  if (presence === "online" || sinceMs === undefined)
    return t(`conversation.presence.${presence}`);
  return t(`conversation.presence.${presence}_since`, {
    time: presenceTime(sinceMs, now),
  });
}

/**
 * Clock time today, "yesterday" with its time, a weekday within the week, a date within the year,
 * then month and year. Computed when shown; a label only changes when the presence does.
 */
export function presenceTime(sinceMs: number, now: number): string {
  const days = calendarDaysBefore(sinceMs, now);
  if (days <= 0) return formatTime(sinceMs);
  if (days === 1)
    return t("conversation.presence.yesterday", { time: formatTime(sinceMs) });
  if (days < 7) return formatWeekday(sinceMs);
  return isSameLocalYear(sinceMs, now)
    ? formatShortDate(sinceMs)
    : formatMonthYear(sinceMs);
}
