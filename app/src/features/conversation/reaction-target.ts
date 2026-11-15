import type { MessageProjection } from "../../engine/generated/MessageProjection";
import type { NetworkProjection } from "../../engine/generated/NetworkProjection";

export type ToggleReaction = (messageId: number, reaction: string) => void;
export type ToggleBufferReaction = (
  bufferId: number,
  messageId: number,
  reaction: string,
) => void;

/** A buffer's reaction toggle exists only while its network can send reactions. */
export function bufferReactionToggle(
  bufferId: number | undefined,
  network: NetworkProjection | undefined,
  toggle: ToggleBufferReaction | undefined,
): ToggleReaction | undefined {
  if (
    bufferId === undefined ||
    toggle === undefined ||
    network?.can_react !== true
  )
    return undefined;
  return (messageId, reaction) => toggle(bufferId, messageId, reaction);
}

/** Reactions target the server's message id, so only rows the server delivered accept them. */
export function reactionTarget(
  message: MessageProjection,
  toggle: ToggleReaction | undefined,
): ((reaction: string) => void) | undefined {
  if (toggle === undefined || !isServerDelivered(message)) return undefined;
  return (reaction) => toggle(message.id, reaction);
}

function isServerDelivered(message: MessageProjection): boolean {
  return (
    message.server_ids.length > 0 &&
    (message.delivery === "received" || message.delivery === "confirmed")
  );
}
