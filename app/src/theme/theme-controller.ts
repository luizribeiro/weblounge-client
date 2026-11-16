import { resolveTheme, type ThemePreference } from "./resolve-theme";
import { type ThemeDefinition, type ThemeId, themes } from "./theme-registry";

export type { ThemePreference };

export interface ThemeController {
  readonly activeTheme: () => ThemeId;
  setPreference(preference: ThemePreference): void;
  setSystemDark(dark: boolean): void;
  dispose(): void;
}

export function installTheme(
  document: Document,
  initialSystemDark: boolean,
  initialPreference: ThemePreference = "system",
  onApply: (theme: ThemeDefinition) => void = () => {},
): ThemeController {
  let preference = initialPreference;
  let systemDark = initialSystemDark;
  const resolveActive = () =>
    registeredTheme(resolveTheme(preference, systemDark));
  let active = resolveActive();

  const apply = () => {
    active = resolveActive();
    document.documentElement.dataset.theme = active.id;
    onApply(active);
  };
  apply();
  return {
    activeTheme: () => active.id,
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

function registeredTheme(id: string): ThemeDefinition {
  const theme = themes.find((candidate) => candidate.id === id);
  if (theme === undefined) throw new Error(`unknown theme: ${id}`);
  return theme;
}
