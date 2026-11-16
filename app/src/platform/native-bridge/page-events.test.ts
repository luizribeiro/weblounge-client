import { describe, expect, it } from "vitest";
import { observeNativePageEvents } from "./page-events";

function observed() {
  const target = new EventTarget();
  const received: unknown[] = [];
  const stop = observeNativePageEvents(target, {
    "weblounge:open-route": (route) => received.push(["open-route", route]),
    "weblounge:lifecycle": (lifecycle) =>
      received.push(["lifecycle", lifecycle]),
  });
  const dispatch = (name: string, detail: unknown) =>
    target.dispatchEvent(new CustomEvent(name, { detail }));
  return { dispatch, received, stop };
}

describe("native page events", () => {
  it("hands the shell's tap and lifecycle events to their handlers", () => {
    const { dispatch, received } = observed();

    dispatch("weblounge:open-route", "/Libera/@mel");
    dispatch("weblounge:lifecycle", "background");
    dispatch("weblounge:lifecycle", "foreground");

    expect(received).toEqual([
      ["open-route", "/Libera/@mel"],
      ["lifecycle", "background"],
      ["lifecycle", "foreground"],
    ]);
  });

  it("drops events whose detail breaks the contract", () => {
    const { dispatch, received } = observed();

    dispatch("weblounge:open-route", { route: "/Libera/@mel" });
    dispatch("weblounge:lifecycle", "suspended");
    expect(received).toEqual([]);
  });

  it("stops listening once disposed", () => {
    const { dispatch, received, stop } = observed();

    stop();
    dispatch("weblounge:lifecycle", "background");
    expect(received).toEqual([]);
  });
});
