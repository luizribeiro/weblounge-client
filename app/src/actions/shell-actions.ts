import type { UiActionId } from "./action-registry";

export const shellActionEvent = "weblounge:action";
const shellMenuActions = [
  "settings.open",
  "buffer.next",
  "buffer.previous",
] as const satisfies readonly UiActionId[];
export type ShellMenuAction = (typeof shellMenuActions)[number];

export function listenForShellActions(
  target: EventTarget,
  run: (action: ShellMenuAction) => void,
): () => void {
  const listener = (event: Event) => {
    const action = event instanceof CustomEvent ? event.detail : undefined;
    const allowed = shellMenuActions.find((candidate) => candidate === action);
    if (allowed !== undefined) run(allowed);
  };
  target.addEventListener(shellActionEvent, listener);
  return () => target.removeEventListener(shellActionEvent, listener);
}
