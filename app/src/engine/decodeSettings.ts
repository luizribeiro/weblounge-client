import { isOneOf, isRecord } from "./decode-primitives";
import type { Density } from "./generated/Density";
import type { Settings } from "./generated/Settings";
import type { ThemePreference } from "./generated/ThemePreference";

export const themePreferences = everyValueOf<ThemePreference>()([
  "system",
  "lounge",
  "lounge-night",
]);
export const densities = everyValueOf<Density>()([
  "compact",
  "cozy",
  "comfortable",
]);

export function decodeSettings(value: unknown): Settings | undefined {
  if (!isRecord(value) || !isRecord(value.app)) return undefined;
  const { theme, message_density } = value.app;
  if (!isOneOf(theme, themePreferences) || !isOneOf(message_density, densities))
    return undefined;
  return { app: { theme, message_density } };
}

function everyValueOf<T extends string>() {
  return <const L extends readonly T[]>(
    values: L &
      ([Exclude<T, L[number]>] extends [never]
        ? unknown
        : { readonly missing: Exclude<T, L[number]> }),
  ): L => values;
}
