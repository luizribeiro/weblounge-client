import type { AppSettings } from "../../engine/generated/AppSettings";
import type { SettingChange } from "../../engine/generated/SettingChange";

export interface SettingsPageProps {
  readonly settings: AppSettings | undefined;
  readonly onChange: (change: SettingChange) => void;
}
