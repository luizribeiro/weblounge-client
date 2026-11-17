import type { AppSettings } from "../../engine/generated/AppSettings";
import type { SettingChange } from "../../engine/generated/SettingChange";
import type { NotificationSwitch } from "./push-settings";

export interface SettingsPageProps {
  readonly settings: AppSettings | undefined;
  readonly onChange: (change: SettingChange) => void;
  /** Undefined where this host offers no notification switch. */
  readonly notifications?: NotificationSwitch | undefined;
}
