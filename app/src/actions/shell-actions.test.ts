import { describe, expect, it, vi } from "vitest";
import { ActionRegistry } from "./action-registry";
import { listenForShellActions, shellActionEvent } from "./shell-actions";

function dispatch(target: EventTarget, detail: unknown): void {
  target.dispatchEvent(new CustomEvent(shellActionEvent, { detail }));
}

describe("listenForShellActions", () => {
  it("runs Settings when the Mac app menu asks for it", () => {
    const target = new EventTarget();
    const run = vi.fn();
    listenForShellActions(target, run);

    dispatch(target, "settings.open");

    expect(run).toHaveBeenCalledWith("settings.open");
  });

  it("moves between conversations the same way as the keyboard chords", () => {
    const next = vi.fn();
    const previous = vi.fn();
    const registry = new ActionRegistry(
      { "buffer.next": next, "buffer.previous": previous },
      "macos",
    );
    const context = { bufferCount: 3, listActive: false };
    const target = new EventTarget();
    listenForShellActions(target, (action) => registry.run(action, context));
    const chord = (key: string) =>
      registry.handleKeydown(
        new KeyboardEvent("keydown", { altKey: true, cancelable: true, key }),
        context,
      );

    dispatch(target, "buffer.next");
    chord("ArrowDown");
    dispatch(target, "buffer.previous");
    chord("ArrowUp");

    expect(next.mock.calls).toEqual([[context], [context]]);
    expect(previous.mock.calls).toEqual([[context], [context]]);
  });

  it("ignores actions outside the shell menu list and malformed events", () => {
    const target = new EventTarget();
    const run = vi.fn();
    listenForShellActions(target, run);

    dispatch(target, "debug.overlay");
    dispatch(target, { action: "settings.open" });
    dispatch(target, 42);
    target.dispatchEvent(new Event(shellActionEvent));

    expect(run).not.toHaveBeenCalled();
  });

  it("stops listening once removed", () => {
    const target = new EventTarget();
    const run = vi.fn();
    const stop = listenForShellActions(target, run);

    stop();
    dispatch(target, "settings.open");

    expect(run).not.toHaveBeenCalled();
  });
});
