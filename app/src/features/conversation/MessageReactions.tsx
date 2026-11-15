import type { MessageProjection } from "../../engine/generated/MessageProjection";
import { ReactionChips } from "./ReactionChips";
import { reactionTarget, type ToggleReaction } from "./reaction-target";

export function MessageReactions(props: {
  readonly message: MessageProjection;
  readonly onToggle?: ToggleReaction | undefined;
  readonly presentation?: "desktop" | "mobile" | undefined;
}) {
  return (
    <ReactionChips
      onToggle={reactionTarget(props.message, props.onToggle)}
      presentation={props.presentation}
      reactions={props.message.reactions}
    />
  );
}
