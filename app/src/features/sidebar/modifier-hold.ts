import { type Accessor, createSignal, onCleanup } from "solid-js";
import type { ModifierChord } from "../../actions/action-registry";

const modifierKeys: ReadonlySet<string> = new Set([
  "Alt",
  "Control",
  "Meta",
  "Shift",
]);

export function isExactChord(
  event: KeyboardEvent,
  chord: ModifierChord,
): boolean {
  return (
    !event.getModifierState("AltGraph") &&
    event.altKey === chord.alt &&
    event.ctrlKey === chord.ctrl &&
    event.metaKey === chord.meta &&
    event.shiftKey === chord.shift
  );
}

export function createModifierHold(
  target: Window,
  chord: ModifierChord | undefined,
): Accessor<boolean> {
  const [held, setHeld] = createSignal(false);
  if (chord === undefined) return held;
  const release = () => setHeld(false);
  const keydown = (event: KeyboardEvent) => {
    const modifier = modifierKeys.has(event.key);
    if (modifier && event.repeat) return;
    setHeld(modifier && isExactChord(event, chord));
  };
  const keyup = (event: KeyboardEvent) => {
    if (modifierKeys.has(event.key)) release();
  };
  const visibilityChanged = () => {
    if (target.document.visibilityState !== "visible") release();
  };
  target.addEventListener("keydown", keydown, true);
  target.addEventListener("keyup", keyup, true);
  target.addEventListener("blur", release);
  target.document.addEventListener("visibilitychange", visibilityChanged);
  onCleanup(() => {
    target.removeEventListener("keydown", keydown, true);
    target.removeEventListener("keyup", keyup, true);
    target.removeEventListener("blur", release);
    target.document.removeEventListener("visibilitychange", visibilityChanged);
  });
  return held;
}
