import { describe, expect, it } from "vitest";
import { observeNativePageEvents } from "./page-events";

const token =
  "5f0c3e8a9b1d2c4e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6";

function observed() {
  const target = new EventTarget();
  const received: unknown[] = [];
  const stop = observeNativePageEvents(target, {
    "weblounge:open-route": (route) => received.push(["open-route", route]),
    "weblounge:lifecycle": (lifecycle) =>
      received.push(["lifecycle", lifecycle]),
    "weblounge:push-target": (target) => received.push(["push-target", target]),
  });
  const dispatch = (name: string, detail: unknown) =>
    target.dispatchEvent(new CustomEvent(name, { detail }));
  return { dispatch, received, stop };
}

describe("native page events", () => {
  it("hands the shell's tap, lifecycle and token events to their handlers", () => {
    const { dispatch, received } = observed();

    dispatch("weblounge:open-route", "/Libera/@mel");
    dispatch("weblounge:lifecycle", "background");
    dispatch("weblounge:lifecycle", "foreground");
    dispatch("weblounge:push-target", {
      platform: "apns",
      token,
      environment: "sandbox",
    });

    expect(received).toEqual([
      ["open-route", "/Libera/@mel"],
      ["lifecycle", "background"],
      ["lifecycle", "foreground"],
      ["push-target", { platform: "apns", token, environment: "sandbox" }],
    ]);
  });

  it("drops events whose detail breaks the contract", () => {
    const { dispatch, received } = observed();

    dispatch("weblounge:open-route", { route: "/Libera/@mel" });
    dispatch("weblounge:lifecycle", "suspended");
    for (const target of [
      { platform: "apns", token: token.toUpperCase(), environment: "sandbox" },
      { platform: "apns", token: token.slice(1), environment: "sandbox" },
      { platform: "apns", token, environment: "staging" },
      { platform: "fcm", token, environment: "production" },
      null,
    ])
      dispatch("weblounge:push-target", target);
    expect(received).toEqual([]);
  });

  it("stops listening once disposed", () => {
    const { dispatch, received, stop } = observed();

    stop();
    dispatch("weblounge:lifecycle", "background");
    expect(received).toEqual([]);
  });
});
