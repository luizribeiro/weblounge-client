import { type Accessor, createSignal, onCleanup } from "solid-js";

export interface ClosedConversation {
  readonly networkId: number;
  readonly title: string;
}

export interface CloseUndo {
  readonly closed: Accessor<ClosedConversation | undefined>;
  readonly record: (conversation: ClosedConversation) => void;
  readonly undo: () => void;
}

const undoWindowMs = 6_000;

export function createCloseUndo(
  reopen: (conversation: ClosedConversation) => void,
): CloseUndo {
  const [closed, setClosed] = createSignal<ClosedConversation>();
  let timer: number | undefined;
  const clearTimer = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };
  const dismiss = () => {
    clearTimer();
    setClosed(undefined);
  };
  onCleanup(clearTimer);
  return {
    closed,
    record: (conversation) => {
      clearTimer();
      setClosed(conversation);
      // wait-ok: Undo remains available for the approved fixed six-second window.
      timer = window.setTimeout(dismiss, undoWindowMs);
    },
    undo: () => {
      const conversation = closed();
      if (conversation === undefined) return;
      dismiss();
      reopen(conversation);
    },
  };
}
