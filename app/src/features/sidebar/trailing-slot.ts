export type TrailingSlot = "badge" | "close" | "empty";

export interface TrailingSlotState {
  readonly badge: boolean;
  readonly closable: boolean;
  readonly engaged: boolean;
}

export function trailingSlot(state: TrailingSlotState): TrailingSlot {
  if (state.closable && state.engaged) return "close";
  return state.badge ? "badge" : "empty";
}
