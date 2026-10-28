const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

export function formatTime(time: number | Date): string {
  return timeFormatter.format(time);
}
