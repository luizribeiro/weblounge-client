export type MobileScreen =
  | { readonly kind: "chats" }
  | { readonly kind: "chat"; readonly bufferId: number };

export interface MobileTransition {
  readonly direction: "push" | "pop";
  readonly from: MobileScreen;
  readonly to: MobileScreen;
  readonly duration: 230 | 280;
}

export interface MobileStack {
  readonly active: MobileScreen;
  readonly transition?: MobileTransition | undefined;
}

export function createMobileStack(): MobileStack {
  return { active: { kind: "chats" } };
}

export function pushChat(
  state: MobileStack,
  bufferId: number,
  reducedMotion: boolean,
): MobileStack {
  const to = { kind: "chat", bufferId } as const;
  if (reducedMotion) return { active: to };
  return {
    active: to,
    transition: { direction: "push", from: state.active, to, duration: 280 },
  };
}

export function popChat(
  state: MobileStack,
  reducedMotion: boolean,
): MobileStack {
  if (state.active.kind === "chats") return state;
  const to = { kind: "chats" } as const;
  if (reducedMotion) return { active: to };
  return {
    active: to,
    transition: { direction: "pop", from: state.active, to, duration: 230 },
  };
}

export function finishTransition(state: MobileStack): MobileStack {
  return state.transition === undefined ? state : { active: state.active };
}

export function mountedScreens(state: MobileStack): readonly MobileScreen[] {
  return state.transition === undefined
    ? [state.active]
    : [state.transition.from, state.transition.to];
}

export function swipeBackCompletes(
  distance: number,
  width: number,
  velocity: number,
): boolean {
  return distance > 0 && (distance >= width / 2 || velocity >= 0.5);
}
