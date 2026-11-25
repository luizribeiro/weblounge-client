import type { AppSettings } from "../../engine/generated/AppSettings";
import type { SettingChange } from "../../engine/generated/SettingChange";
import type { NotificationSwitch } from "./push-settings";

/** The member's weblounge account, where the app signed in through the members' site. */
export interface AccountControls {
  /** The members' site, where the account and invitations are managed. */
  readonly membersSite: string;
  readonly onSignOut: () => void;
}

export interface SettingsPageProps {
  readonly settings: AppSettings | undefined;
  readonly onChange: (change: SettingChange) => void;
  /** Undefined where this host offers no notification switch. */
  readonly notifications?: NotificationSwitch | undefined;
  /** Undefined where the app didn't sign in to a weblounge account. */
  readonly account?: AccountControls | undefined;
}

/** What this host offers beyond the settings themselves; it decides which sections show. */
export type SettingsHost = Pick<SettingsPageProps, "notifications" | "account">;
