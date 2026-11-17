import type { AppSettings } from "../../engine/generated/AppSettings";
import type { SettingChange } from "../../engine/generated/SettingChange";
import type { PushSettings } from "./push-settings";

export interface SettingsPageProps {
  readonly settings: AppSettings | undefined;
  readonly onChange: (change: SettingChange) => void;
  /** Undefined where this platform can't push, so the push row is hidden. */
  readonly push?: PushSettings | undefined;
}
