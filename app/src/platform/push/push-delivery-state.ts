export interface PushPresentationState<T> {
  expired: boolean;
  shown: boolean;
  showing: Promise<void> | undefined;
  generic: T;
  fallback: Promise<void>;
  deadline: ReturnType<typeof setTimeout> | undefined;
  readonly present: (presentation: T) => Promise<void>;
}

export interface NotificationCounts {
  readonly conversations: Map<string, number>;
  readonly readAtMs: Map<string, number>;
  untagged: number;
}

export function schedulePushPresentation<T>(
  generic: T,
  present: (presentation: T) => Promise<void>,
  deadlineMs: number,
): PushPresentationState<T> {
  const state: PushPresentationState<T> = {
    expired: false,
    shown: false,
    showing: undefined,
    generic,
    fallback: Promise.resolve(),
    deadline: undefined,
    present,
  };
  state.fallback = new Promise<void>((resolve) => {
    state.deadline = setTimeout(() => {
      state.expired = true;
      void retryPresentation(state).finally(resolve);
    }, deadlineMs);
  });
  return state;
}

export async function showOnce<T>(
  state: PushPresentationState<T>,
  presentation: T,
): Promise<void> {
  if (state.shown) return;
  if (state.showing !== undefined) return state.showing;
  const attempt = state.present(presentation);
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
}

export function recordPresentedNotification(
  counts: NotificationCounts,
  tag: string | undefined,
): void {
  if (tag === undefined || tag.length === 0) {
    counts.untagged += 1;
    return;
  }
  counts.conversations.set(tag, (counts.conversations.get(tag) ?? 0) + 1);
  counts.readAtMs.delete(tag);
}

export function notificationDataIsRead(
  data: unknown,
  readMarkers: ReadonlyMap<string, number>,
): boolean {
  if (typeof data !== "object" || data === null) return false;
  if (
    !("conversationTag" in data) ||
    typeof data.conversationTag !== "string" ||
    !("messageTime" in data) ||
    typeof data.messageTime !== "string"
  )
    return false;
  const marker = readMarkers.get(data.conversationTag);
  const messageTime = Date.parse(data.messageTime);
  return (
    marker !== undefined && !Number.isNaN(messageTime) && messageTime <= marker
  );
}

async function retryPresentation<T>(
  state: PushPresentationState<T>,
): Promise<void> {
  try {
    await showOnce(state, state.generic);
  } catch {
    await showOnce(state, state.generic).catch(() => undefined);
  }
}
