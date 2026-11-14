import { describe, expect, it, vi } from "vitest";
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
