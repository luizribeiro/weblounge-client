const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});

const timeColumnWidth = `${widestTimeLength(timeFormatter) + 1}ch`;

export function formatTime(time: number | Date): string {
  return timeFormatter.format(time);
}

export function formatShortDate(time: number | Date): string {
  return shortDateFormatter.format(time);
}

/** A time for a moment today, otherwise its date. */
export function formatTimeOrDate(time: number, now = Date.now()): string {
  return new Date(time).toDateString() === new Date(now).toDateString()
    ? formatTime(time)
    : formatShortDate(time);
}

export function formattedTimeColumnWidth(): string {
  return timeColumnWidth;
}

export function widestTimeLength(formatter: Intl.DateTimeFormat): number {
  let widest = 0;
  for (let hour = 0; hour < 24; hour += 1) {
    for (const minute of [0, 11, 22, 33, 44, 55]) {
      const value = formatter.format(new Date(2026, 0, 1, hour, minute));
      widest = Math.max(widest, Array.from(value).length);
    }
  }
  return widest;
}
