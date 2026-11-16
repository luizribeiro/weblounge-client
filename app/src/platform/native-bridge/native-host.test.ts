import { describe, expect, it, vi } from "vitest";
import type { NativeBridge } from "./native-bridge";
import { startHostIntegration } from "./native-host";

function shell() {
  const log: string[] = [];
  const target = new EventTarget();
  const bridge = {
    call: async (command: string) => {
      log.push(command);
      return [];
    },
  } as NativeBridge;
  const events = {
    openRoute: (route: string) => log.push(`open ${route}`),
    background: () => log.push("background"),
    foreground: () => log.push("foreground"),
  };
  const dispatch = (name: string, detail: string) =>
    target.dispatchEvent(new CustomEvent(name, { detail }));
  return { bridge, dispatch, events, log, target };
}

describe("host integration", () => {
  it("opens the launch route and each tapped route after draining", async () => {
    const { bridge, dispatch, events, log, target } = shell();

    startHostIntegration(events, "/Lounge/@mel", bridge, target);
    await vi.waitFor(() => expect(log).toContain("open /Lounge/@mel"));
    dispatch("weblounge:open-route", "/Lounge/%23ops");
    await vi.waitFor(() => expect(log).toContain("open /Lounge/%23ops"));

    expect(log).toEqual([
      "take_pushed_messages",
      "open /Lounge/@mel",
      "take_pushed_messages",
      "open /Lounge/%23ops",
    ]);
  });

  it("releases on background and drains on foreground", async () => {
    const { bridge, dispatch, events, log, target } = shell();
    startHostIntegration(events, "/", bridge, target);
    await vi.waitFor(() => expect(log).toContain("open /"));
    log.length = 0;

    dispatch("weblounge:lifecycle", "background");
    dispatch("weblounge:lifecycle", "foreground");

    expect(log).toEqual(["background", "take_pushed_messages", "foreground"]);
  });

  it("ignores the shell's events once stopped", async () => {
    const { bridge, dispatch, events, log, target } = shell();
    const stop = startHostIntegration(events, "/", bridge, target);
    await vi.waitFor(() => expect(log).toContain("open /"));
    log.length = 0;

    stop();
    dispatch("weblounge:open-route", "/Lounge/@mel");
    dispatch("weblounge:lifecycle", "background");

    expect(log).toEqual([]);
  });

  it("does nothing outside the iPhone app", () => {
    const { dispatch, events, log, target } = shell();

    startHostIntegration(events, "/Lounge/@mel", undefined, target);
    dispatch("weblounge:open-route", "/Lounge/@mel");

    expect(log).toEqual([]);
  });
});
