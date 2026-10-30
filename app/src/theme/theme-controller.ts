import { type ThemeId, themes } from "./theme-registry";

export type ThemePreference = "system" | ThemeId;

export interface ThemeController {
  readonly activeTheme: () => ThemeId;
  setPreference(preference: ThemePreference): void;
  setSystemDark(dark: boolean): void;
  dispose(): void;
}

export function installTheme(
  document: Document,
  initialSystemDark: boolean,
): ThemeController {
  let preference: ThemePreference = "system";
  let systemDark = initialSystemDark;
  let active = resolveSystemTheme(systemDark);

  const apply = () => {
    active =
      preference === "system" ? resolveSystemTheme(systemDark) : preference;
    const theme = themes.find((candidate) => candidate.id === active);
    if (theme === undefined) throw new Error(`unknown theme: ${active}`);
    document.documentElement.dataset.theme = active;
  };
  apply();
  return {
    activeTheme: () => active,
    setPreference(nextPreference) {
      preference = nextPreference;
      apply();
    },
    setSystemDark(dark) {
      systemDark = dark;
      if (preference === "system") apply();
    },
    dispose() {},
  };
}

function resolveSystemTheme(dark: boolean): ThemeId {
  const id = dark ? "lounge-night" : "lounge";
  const theme = themes.find((candidate) => candidate.id === id);
  if (theme === undefined) throw new Error(`missing system theme: ${id}`);
  return theme.id;
}
