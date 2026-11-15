import type { MessageProjection } from "../../engine/generated/MessageProjection";
import type { NetworkProjection } from "../../engine/generated/NetworkProjection";
import { isRedacted } from "../../engine/message-kind";

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

export function isServerDelivered(message: MessageProjection): boolean {
  return (
    message.server_ids.length > 0 &&
    !isRedacted(message.kind) &&
    (message.delivery === "received" || message.delivery === "confirmed")
  );
}

export function ownReactions(message: MessageProjection): ReadonlySet<string> {
  return new Set(
    (message.reactions ?? [])
      .filter((reaction) => reaction.mine)
      .map((reaction) => reaction.text),
  );
}
