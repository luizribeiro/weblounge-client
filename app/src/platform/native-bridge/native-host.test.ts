import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeBridge } from "./native-bridge";
import {
  captureNativeEventsAtStartup,
  startHostIntegration,
} from "./native-host";

const running: (() => void)[] = [];

afterEach(() => {
  for (const stop of running.splice(0)) stop();
});

function shell(native = true) {
  const log: string[] = [];
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
  const start = (launchRoute: string) => {
    const stop = startHostIntegration(
      events,
      launchRoute,
      native ? bridge : undefined,
    );
    running.push(stop);
    return stop;
  };
  const dispatch = (name: string, detail: string) =>
    window.dispatchEvent(new CustomEvent(name, { detail }));
  return { dispatch, log, start };
}

describe("host integration", () => {
  it("opens the launch route and each tapped route after draining", async () => {
    const { dispatch, log, start } = shell();

    start("/Lounge/@mel");
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

  it("keeps a tap that arrives before the app mounts and opens it after the launch route", async () => {
    const { dispatch, log, start } = shell();
    const bridge = { call: async () => [] } as unknown as NativeBridge;

    captureNativeEventsAtStartup(bridge);
    dispatch("weblounge:open-route", "/Lounge/%23ops");
    start("/");
    await vi.waitFor(() => expect(log).toContain("open /Lounge/%23ops"));
    dispatch("weblounge:open-route", "/Lounge/@mel");
    await vi.waitFor(() => expect(log).toContain("open /Lounge/@mel"));

    expect(log.filter((entry) => entry.startsWith("open"))).toEqual([
      "open /",
      "open /Lounge/%23ops",
      "open /Lounge/@mel",
    ]);
  });

  it("captures nothing outside the iPhone app", async () => {
    const { dispatch, log, start } = shell();

    captureNativeEventsAtStartup(undefined);
    dispatch("weblounge:open-route", "/Lounge/%23ops");
    start("/");
    await vi.waitFor(() => expect(log).toContain("open /"));

    expect(log).not.toContain("open /Lounge/%23ops");
  });

  it("releases on background and drains on foreground", async () => {
    const { dispatch, log, start } = shell();
    start("/");
    await vi.waitFor(() => expect(log).toContain("open /"));
    log.length = 0;

    dispatch("weblounge:lifecycle", "background");
    dispatch("weblounge:lifecycle", "foreground");

    expect(log).toEqual(["background", "take_pushed_messages", "foreground"]);
  });

  it("ignores the shell's events once stopped", async () => {
    const { dispatch, log, start } = shell();
    const stop = start("/");
    await vi.waitFor(() => expect(log).toContain("open /"));
    log.length = 0;

    stop();
    dispatch("weblounge:open-route", "/Lounge/@mel");
    dispatch("weblounge:lifecycle", "background");

    expect(log).toEqual([]);
  });

  it("does nothing outside the iPhone app", () => {
    const { dispatch, log, start } = shell(false);

    start("/Lounge/@mel");
    dispatch("weblounge:open-route", "/Lounge/@mel");
    dispatch("weblounge:lifecycle", "background");

    expect(log).toEqual([]);
  });
});
