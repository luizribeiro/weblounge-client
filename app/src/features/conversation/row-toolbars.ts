import { type Accessor, createMemo, createSignal, type Setter } from "solid-js";
import type { MessageId } from "../../engine/generated/MessageId";

/** One row's view of the list's toolbar owner, bound to its message. */
export interface RowToolbar {
  readonly shown: Accessor<boolean>;
  readonly mount: (row: HTMLElement) => void;
  readonly unmount: () => void;
  readonly revealForKeyboard: () => void;
  /** Keeps this row's toolbar up, and every other row's down, until released. */
  readonly pin: () => () => void;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly onFocusIn: (
    event: FocusEvent & { currentTarget: HTMLElement },
  ) => void;
  readonly onFocusOut: (
    event: FocusEvent & { currentTarget: HTMLElement },
  ) => void;
}

export interface RowToolbars {
  readonly row: (id: MessageId) => RowToolbar;
}

/**
 * The single owner of which desktop row shows its toolbar, so at most one does: a row with an
 * open menu or picker, else the row holding keyboard focus, else the hovered row.
 */
export function createRowToolbars(
  menuRow: Accessor<MessageId | undefined>,
): RowToolbars {
  const [pinned, setPinned] = createSignal<MessageId>();
  const [keyboard, setKeyboard] = createSignal<MessageId>();
  const [hovered, setHovered] = createSignal<MessageId>();
  const shownRow = createMemo(
    () => pinned() ?? menuRow() ?? keyboard() ?? hovered(),
  );
  const release = (set: Setter<MessageId | undefined>, id: MessageId) =>
    set((current) => (current === id ? undefined : current));
  return {
    row: (id) => ({
      shown: () => shownRow() === id,
      mount: (row) => {
        if (row.matches(":hover")) setHovered(id);
        const focused = document.activeElement;
        if (row.contains(focused) && isFocusVisible(focused)) setKeyboard(id);
      },
      unmount: () => {
        release(setHovered, id);
        release(setKeyboard, id);
      },
      revealForKeyboard: () => setKeyboard(id),
      pin: () => {
        setPinned(id);
        return () => release(setPinned, id);
      },
      onPointerEnter: () => setHovered(id),
      onPointerLeave: () => release(setHovered, id),
      onFocusIn: (event) => {
        if (!isInside(event.currentTarget, event.target)) return;
        if (isFocusVisible(event.target)) setKeyboard(id);
        else release(setKeyboard, id);
      },
      onFocusOut: (event) => {
        if (!isInside(event.currentTarget, event.relatedTarget))
          release(setKeyboard, id);
      },
    }),
  };
}

/** Solid delegates focus events through portals, so a portalled picker's focus also reaches its row. */
function isInside(row: HTMLElement, target: EventTarget | null): boolean {
  return target instanceof Node && row.contains(target);
}

function isFocusVisible(target: EventTarget | null): boolean {
  return target instanceof Element && target.matches(":focus-visible");
}
