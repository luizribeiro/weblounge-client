export interface PushPresentationState<T> {
  expired: boolean;
  shown: boolean;
  showing: Promise<void> | undefined;
  generic: T;
  fallback: Promise<void>;
  deadline: ReturnType<typeof setTimeout> | undefined;
  resolveFallback: (() => void) | undefined;
  readonly presentationExpiresAt: number;
  presentationFailure: unknown;
  presentationFailureReported: boolean;
  readonly present: (presentation: T) => Promise<void>;
  readonly reportError: (error: unknown) => void;
}

export function schedulePushPresentation<T>(
  generic: T,
  present: (presentation: T) => Promise<void>,
  fallbackDeadlineMs: number,
  presentationBudgetMs: number,
  reportError: (error: unknown) => void,
): PushPresentationState<T> {
  const state: PushPresentationState<T> = {
    expired: false,
    shown: false,
    showing: undefined,
    generic,
    fallback: Promise.resolve(),
    deadline: undefined,
    resolveFallback: undefined,
    presentationExpiresAt: Date.now() + presentationBudgetMs,
    presentationFailure: undefined,
    presentationFailureReported: false,
    present,
    reportError,
  };
  state.fallback = new Promise<void>((resolve) => {
    state.resolveFallback = resolve;
    state.deadline = setTimeout(() => {
      state.expired = true;
      void showUntilPresented(state, () => state.generic).finally(resolve);
    }, fallbackDeadlineMs);
  });
  return state;
}

export async function showOnce<T>(
  state: PushPresentationState<T>,
  presentation: T,
): Promise<void> {
  if (state.shown) return;
  if (state.showing !== undefined) return state.showing;
  const attempt = Promise.resolve().then(() => state.present(presentation));
  state.showing = attempt;
  try {
    await attempt;
    state.shown = true;
    cancelPresentationDeadline(state);
  } finally {
    state.showing = undefined;
  }
}

export function cancelPresentationDeadline<T>(
  state: PushPresentationState<T>,
): void {
  if (state.deadline !== undefined) clearTimeout(state.deadline);
  state.deadline = undefined;
  state.resolveFallback?.();
  state.resolveFallback = undefined;
}

export async function showUntilPresented<T>(
  state: PushPresentationState<T>,
  presentation: () => T,
): Promise<boolean> {
  let retryDelayMs = 50;
  while (!state.shown && Date.now() < state.presentationExpiresAt) {
    try {
      await showOnce(state, presentation());
    } catch (error: unknown) {
      state.presentationFailure = error;
      const remainingMs = state.presentationExpiresAt - Date.now();
      if (remainingMs <= 0) break;
      await delay(Math.min(retryDelayMs, remainingMs));
      retryDelayMs = Math.min(retryDelayMs * 2, 250);
    }
  }
  if (!state.shown && !state.presentationFailureReported) {
    state.presentationFailureReported = true;
    state.reportError(
      state.presentationFailure ?? new Error("push presentation timed out"),
    );
  }
  return state.shown;
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
