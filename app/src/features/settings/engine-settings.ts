import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import type { EngineClient } from "../../engine/EngineClient";
import type { AppSettings } from "../../engine/generated/AppSettings";
import type { SettingChange } from "../../engine/generated/SettingChange";
import type { Settings } from "../../engine/generated/Settings";

export interface EngineSettings {
  readonly current: Accessor<Settings | undefined>;
  readonly change: (change: SettingChange) => void;
}

interface EngineSettingsOptions {
  readonly client: () => EngineClient | undefined;
  readonly started: Accessor<boolean>;
  readonly onAppearance: (appearance: AppSettings) => void;
}

export function createEngineSettings(
  options: EngineSettingsOptions,
): EngineSettings {
  const [current, setCurrent] = createSignal<Settings>();
  const accept = (settings: Settings) => {
    setCurrent(settings);
    options.onAppearance(settings.app);
  };
  createEffect(() => {
    const client = options.client();
    if (!options.started() || client === undefined) return;
    let loadId: string | undefined;
    const load = () => {
      const id = crypto.randomUUID();
      loadId = id;
      void client
        .send({ id, request: { type: "load_settings" } })
        .catch(() => undefined);
    };
    onCleanup(
      client.subscribe((message) => {
        if (message.type === "ready") load();
        else if (message.type === "settings_changed") {
          loadId = undefined;
          accept(message.settings);
        } else if (
          message.type === "settings_loaded" &&
          message.command_id === loadId
        )
          accept(message.settings);
      }),
    );
    load();
  });
  return {
    current,
    change(change) {
      void options
        .client()
        ?.send({
          id: crypto.randomUUID(),
          request: { type: "change_setting", change },
        })
        .catch(() => undefined);
    },
  };
}
