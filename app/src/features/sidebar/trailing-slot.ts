export type TrailingSlot = "badge" | "close" | "empty" | "hint";

export interface TrailingSlotState {
  readonly badge: boolean;
  readonly closable: boolean;
  readonly engaged: boolean;
  readonly hint: boolean;
}

export function trailingSlot(state: TrailingSlotState): TrailingSlot {
  if (state.hint) return "hint";
  if (state.closable && state.engaged) return "close";
  return state.badge ? "badge" : "empty";
}
