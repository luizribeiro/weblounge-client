import type { ThemePreference } from "../engine/generated/ThemePreference";

export type { ThemePreference };

type FixedTheme = Exclude<ThemePreference, "system">;

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): FixedTheme {
  if (preference !== "system") return preference;
  return systemDark ? "lounge-night" : "lounge";
}
