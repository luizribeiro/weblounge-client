import type { MessageProjection } from "../../engine/protocol";

export function startsMobileMessageGroup(
  previous: MessageProjection | undefined,
  current: MessageProjection,
): boolean {
  if (
    previous?.kind !== "text" ||
    current.kind !== "text" ||
    previous.author !== current.author ||
    previous.authorship !== current.authorship ||
    previous.unverified_sender !== current.unverified_sender
  )
    return true;

  return minuteOf(previous) !== minuteOf(current);
}

function minuteOf(message: MessageProjection): number {
  return Math.floor(
    (message.server_time_ms ?? message.received_at_ms) / 60_000,
  );
}
