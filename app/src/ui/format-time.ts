const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});

const weekdayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
});

const monthYearFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  year: "numeric",
});

const dayMilliseconds = 86_400_000;

const timeColumnWidth = `${widestTimeLength(timeFormatter) + 1}ch`;

export function formatTime(time: number | Date): string {
  return timeFormatter.format(time);
}

export function formatShortDate(time: number | Date): string {
  return shortDateFormatter.format(time);
}

export function formatWeekday(time: number | Date): string {
  return weekdayFormatter.format(time);
}

export function formatMonthYear(time: number | Date): string {
  return monthYearFormatter.format(time);
}

/** Local calendar days from `time` to `now`; rounding absorbs a daylight-saving hour. */
export function calendarDaysBefore(time: number, now: number): number {
  return Math.round(
    (localMidnight(now) - localMidnight(time)) / dayMilliseconds,
  );
}

export function isSameLocalYear(time: number, now: number): boolean {
  return new Date(time).getFullYear() === new Date(now).getFullYear();
}

function localMidnight(time: number): number {
  const date = new Date(time);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
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
