import { type Accessor, createSignal } from "solid-js";

/** Desktop rows show their toolbar while hovered or while keyboard focus is inside them. */
export function createRowToolbarVisibility(): {
  readonly shown: Accessor<boolean>;
  readonly mount: (row: HTMLElement) => void;
  readonly revealForKeyboard: () => void;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly onFocusIn: (event: FocusEvent) => void;
  readonly onFocusOut: (
    event: FocusEvent & { currentTarget: HTMLElement },
  ) => void;
} {
  const [hovered, setHovered] = createSignal(false);
  const [keyboard, setKeyboard] = createSignal(false);
  return {
    shown: () => hovered() || keyboard(),
    mount: (row) => {
      if (row.matches(":hover")) setHovered(true);
      const focused = document.activeElement;
      if (row.contains(focused) && isFocusVisible(focused)) setKeyboard(true);
    },
    revealForKeyboard: () => setKeyboard(true),
    onPointerEnter: () => setHovered(true),
    onPointerLeave: () => setHovered(false),
    onFocusIn: (event) => setKeyboard(isFocusVisible(event.target)),
    onFocusOut: (event) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node && event.currentTarget.contains(next)))
        setKeyboard(false);
    },
  };
}

function isFocusVisible(target: EventTarget | null): boolean {
  return target instanceof Element && target.matches(":focus-visible");
}
