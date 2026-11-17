import type { AppSettings } from "./generated/AppSettings";

export const switchesOn = {
  unread_tab_indicator: true,
  push_on_this_device: true,
} as const satisfies Omit<AppSettings, "theme" | "message_density">;
