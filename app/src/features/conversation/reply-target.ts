import type { MessageProjection } from "../../engine/generated/MessageProjection";
import type { NetworkProjection } from "../../engine/generated/NetworkProjection";
import { isAddressable } from "./reaction-target";

export type StartReply = (message: MessageProjection) => void;
export type StartBufferReply = (
  bufferId: number,
  message: MessageProjection,
) => void;

/** A buffer's reply action exists only while its network can thread replies. */
export function bufferReply(
  bufferId: number | undefined,
  network: NetworkProjection | undefined,
  start: StartBufferReply | undefined,
): StartReply | undefined {
  if (
    bufferId === undefined ||
    start === undefined ||
    network?.can_reply !== true
  )
    return undefined;
  return (message) => start(bufferId, message);
}

/** The reply action of one row, present only for a row papo can address. */
export function replyTarget(
  message: MessageProjection,
  start: StartReply | undefined,
): (() => void) | undefined {
  if (start === undefined || !isAddressable(message)) return undefined;
  return () => start(message);
}
