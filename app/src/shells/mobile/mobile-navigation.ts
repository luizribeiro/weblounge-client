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
  readonly back: readonly MobileScreen[];
  readonly transition?: MobileTransition | undefined;
}

export function createMobileStack(): MobileStack {
  return { active: { kind: "chats" }, back: [] };
}

export function pushChat(
  state: MobileStack,
  bufferId: number,
  reducedMotion: boolean,
  preserveCurrent = false,
): MobileStack {
  const to = { kind: "chat", bufferId } as const;
  const back =
    state.active.kind === "chats"
      ? [state.active]
      : preserveCurrent
        ? [...state.back, state.active]
        : state.back;
  if (reducedMotion) return { active: to, back };
  return {
    active: to,
    back,
    transition: { direction: "push", from: state.active, to, duration: 280 },
  };
}

export function popChat(
  state: MobileStack,
  reducedMotion: boolean,
): MobileStack {
  const to = state.back.at(-1);
  if (to === undefined) return state;
  const back = state.back.slice(0, -1);
  if (reducedMotion) return { active: to, back };
  return {
    active: to,
    back,
    transition: { direction: "pop", from: state.active, to, duration: 230 },
  };
}

export function finishTransition(state: MobileStack): MobileStack {
  return state.transition === undefined
    ? state
    : { active: state.active, back: state.back };
}

export function mountedScreens(state: MobileStack): readonly MobileScreen[] {
  return state.transition === undefined
    ? [state.active]
    : [state.transition.from, state.transition.to];
}

export function previousScreen(state: MobileStack): MobileScreen {
  return state.back.at(-1) ?? { kind: "chats" };
}

export function swipeBackCompletes(
  distance: number,
  width: number,
  velocity: number,
): boolean {
  return distance > 0 && (distance >= width / 2 || velocity >= 0.5);
}
