import type { MessageProjection } from "../../engine/generated/MessageProjection";

export type ToggleReaction = (messageId: number, reaction: string) => void;

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
