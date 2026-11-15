import type { MessageProjection } from "../../engine/generated/MessageProjection";
import { isServerDelivered } from "./reaction-target";

export type RedactMessage = (messageId: number) => void;

/** Only your own messages the server delivered can be deleted, one deletion at a time. */
export function canRedact(
  message: MessageProjection,
  redact: RedactMessage | undefined,
): redact is RedactMessage {
  return (
    redact !== undefined &&
    message.authorship === "own" &&
    message.own_redaction !== "sending" &&
    isServerDelivered(message)
  );
}
