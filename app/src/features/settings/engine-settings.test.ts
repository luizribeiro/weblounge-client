import { createRoot, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { EngineClient } from "../../engine/EngineClient";
import type { Settings } from "../../engine/generated/Settings";
import type {
  CommandResult,
  EngineClientMessage,
  EngineRequestEnvelope,
} from "../../engine/protocol";
import { createEngineSettings } from "./engine-settings";

const night: Settings = {
  app: { theme: "lounge-night", message_density: "compact" },
};
const lounge: Settings = {
  app: { theme: "lounge", message_density: "comfortable" },
};

function fakeClient() {
  const listeners = new Set<(message: EngineClientMessage) => void>();
  const sent: EngineRequestEnvelope[] = [];
  const client: Pick<EngineClient, "subscribe" | "send"> = {
    subscribe(listener: (message: EngineClientMessage) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(request: EngineRequestEnvelope): Promise<CommandResult> {
      sent.push(request);
      return Promise.resolve({ type: "command_result", id: request.id });
    },
  };
  const emit = (message: EngineClientMessage) => {
    for (const listener of listeners) listener(message);
  };
  return { client, emit, sent };
}

function setup() {
  const engine = fakeClient();
  const onAppearance = vi.fn();
  const [started, setStarted] = createSignal(false);
  const { settings, dispose } = createRoot((dispose) => ({
    settings: createEngineSettings({
      client: () => engine.client as EngineClient,
      started,
      onAppearance,
    }),
    dispose,
  }));
  return { ...engine, dispose, onAppearance, setStarted, settings };
}

describe("createEngineSettings", () => {
  it("loads settings once the engine has started", () => {
    const { emit, onAppearance, sent, setStarted, settings } = setup();
    expect(sent).toEqual([]);

    setStarted(true);
    const load = sent[0];
    expect(load?.request).toEqual({ type: "load_settings" });
    emit({
      type: "settings_loaded",
      command_id: load?.id ?? "",
      settings: night,
    });

    expect(settings.current()).toEqual(night);
    expect(onAppearance).toHaveBeenCalledWith(night.app);
  });

  it("ignores another tab's load and follows every broadcast change", () => {
    const { emit, onAppearance, setStarted, settings } = setup();
    setStarted(true);

    emit({ type: "settings_loaded", command_id: "other-tab", settings: night });
    expect(settings.current()).toBeUndefined();

    emit({ type: "settings_changed", settings: lounge });
    expect(settings.current()).toEqual(lounge);
    expect(onAppearance).toHaveBeenLastCalledWith(lounge.app);
  });

  it("keeps a change that overtakes an older load", () => {
    const { emit, sent, setStarted, settings } = setup();
    setStarted(true);

    emit({ type: "settings_changed", settings: lounge });
    emit({
      type: "settings_loaded",
      command_id: sent[0]?.id ?? "",
      settings: night,
    });

    expect(settings.current()).toEqual(lounge);
  });

  it("reloads when the engine restarts", () => {
    const { emit, sent, setStarted, settings } = setup();
    setStarted(true);

    emit({ type: "ready", engine_instance: "second", revision: 0 });
    emit({
      type: "settings_loaded",
      command_id: sent[0]?.id ?? "",
      settings: lounge,
    });
    emit({
      type: "settings_loaded",
      command_id: sent[1]?.id ?? "",
      settings: night,
    });

    expect(sent.map(({ request }) => request.type)).toEqual([
      "load_settings",
      "load_settings",
    ]);
    expect(settings.current()).toEqual(night);
  });

  it("asks the engine to change a setting without applying it locally", () => {
    const { sent, setStarted, settings } = setup();
    setStarted(true);

    settings.change({
      scope: "app",
      setting: { key: "theme", value: "lounge-night" },
    });

    expect(sent.at(-1)?.request).toEqual({
      type: "change_setting",
      change: {
        scope: "app",
        setting: { key: "theme", value: "lounge-night" },
      },
    });
    expect(settings.current()).toBeUndefined();
  });

  it("stops listening when disposed", () => {
    const { dispose, emit, setStarted, settings } = setup();
    setStarted(true);
    dispose();

    emit({ type: "settings_changed", settings: lounge });

    expect(settings.current()).toBeUndefined();
  });
});
