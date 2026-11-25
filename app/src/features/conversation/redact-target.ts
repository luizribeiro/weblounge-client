import type { MessageProjection } from "../../engine/generated/MessageProjection";
import type { NetworkProjection } from "../../engine/generated/NetworkProjection";
import { isAddressable } from "./reaction-target";

export type RedactMessage = (messageId: number) => void;
export type RedactBufferMessage = (bufferId: number, messageId: number) => void;

/** A buffer's delete action exists only while its network can delete messages. */
export function bufferRedaction(
  bufferId: number | undefined,
  network: NetworkProjection | undefined,
  redact: RedactBufferMessage | undefined,
): RedactMessage | undefined {
  if (
    bufferId === undefined ||
    redact === undefined ||
    network?.can_redact !== true
  )
    return undefined;
  return (messageId) => redact(bufferId, messageId);
}

/** Only your own messages the server delivered can be deleted, one deletion at a time. */
export function canRedact(
  message: MessageProjection,
  redact: RedactMessage | undefined,
): redact is RedactMessage {
  return (
    redact !== undefined &&
    message.authorship === "own" &&
    message.own_redaction !== "sending" &&
    isAddressable(message)
  );
}
