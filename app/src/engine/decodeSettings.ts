import { isOneOf, isRecord } from "./decode-primitives";
import type { AppSettings } from "./generated/AppSettings";
import type { Density } from "./generated/Density";
import type { Settings } from "./generated/Settings";
import type { ThemePreference } from "./generated/ThemePreference";

export const themePreferences = everyValueOf<ThemePreference>()([
  "system",
  "lounge",
  "lounge-night",
  "black",
  "modern",
  "terminal",
  "retro",
  "monokai",
  "earthsong",
  "ne",
]);
export const densities = everyValueOf<Density>()([
  "compact",
  "cozy",
  "comfortable",
]);

export type Appearance = Pick<AppSettings, "theme" | "message_density">;

export function decodeAppearance(value: unknown): Appearance | undefined {
  if (!isRecord(value)) return undefined;
  const { theme, message_density } = value;
  if (!isOneOf(theme, themePreferences) || !isOneOf(message_density, densities))
    return undefined;
  return { theme, message_density };
}

type Switches = Omit<AppSettings, keyof Appearance>;

export function decodeSettings(value: unknown): Settings | undefined {
  if (!isRecord(value) || !isRecord(value.app)) return undefined;
  const appearance = decodeAppearance(value.app);
  const switches = decodeSwitches(value.app);
  if (appearance === undefined || switches === undefined) return undefined;
  return { app: { ...appearance, ...switches } };
}

function decodeSwitches(app: Record<string, unknown>): Switches | undefined {
  const { unread_tab_indicator, push_on_this_device, page_notifications } = app;
  if (
    typeof unread_tab_indicator !== "boolean" ||
    typeof push_on_this_device !== "boolean" ||
    typeof page_notifications !== "boolean"
  )
    return undefined;
  return { unread_tab_indicator, push_on_this_device, page_notifications };
}

function everyValueOf<T extends string>() {
  return <const L extends readonly T[]>(
    values: L &
      ([Exclude<T, L[number]>] extends [never]
        ? unknown
        : { readonly missing: Exclude<T, L[number]> }),
  ): L => values;
}
