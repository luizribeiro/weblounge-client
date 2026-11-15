import type { ToggleReaction } from "./reaction-target";

/** Reaction actions shared by every row of one transcript. */
export interface RowReactions {
  readonly toggle: ToggleReaction;
  /** The focus key a re-rendered row should hand focus back to, if any. */
  readonly focusToRestore: (messageId: number) => string | undefined;
}

/**
 * A reaction change re-renders its whole row, once while sending and again on confirmation,
 * which drops the focused control; each row that comes back hands focus to the same control
 * until focus moves elsewhere, so keyboard users keep their place.
 */
export function createRowReactions(toggle: ToggleReaction): RowReactions {
  let pending: { readonly messageId: number; readonly key: string } | undefined;
  return {
    toggle(messageId, reaction) {
      const key = focusKey(document.activeElement);
      pending = key === undefined ? undefined : { messageId, key };
      toggle(messageId, reaction);
    },
    focusToRestore(messageId) {
      if (pending?.messageId !== messageId) return undefined;
      if (
        document.activeElement !== null &&
        document.activeElement !== document.body
      ) {
        pending = undefined;
        return undefined;
      }
      return pending.key;
    },
  };
}

export function focusControl(row: HTMLElement, key: string): void {
  [...row.querySelectorAll<HTMLElement>("[data-focus-key]")]
    .find((control) => control.dataset.focusKey === key)
    ?.focus({ preventScroll: true });
}

function focusKey(element: Element | null): string | undefined {
  return element instanceof HTMLElement && element.matches(":focus-visible")
    ? element.dataset.focusKey
    : undefined;
}
