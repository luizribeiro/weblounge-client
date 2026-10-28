import { type ThemeId, themeStyleSheet, themes } from "./theme-registry";

export type ThemePreference = "system" | ThemeId;

export interface ThemeController {
  readonly activeTheme: () => ThemeId;
  setPreference(preference: ThemePreference): void;
  dispose(): void;
}

interface MediaPreference {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

export function installSystemTheme(
  document: Document,
  window: Window,
): ThemeController {
  const media =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : {
          matches: false,
          addEventListener: () => {},
          removeEventListener: () => {},
        };
  return installTheme(document, media);
}

export function installTheme(
  document: Document,
  media: MediaPreference,
): ThemeController {
  const style = document.createElement("style");
  style.dataset.themeTokens = "true";
  style.textContent = themeStyleSheet();
  document.head.append(style);
  let preference: ThemePreference = "system";
  let active = resolveSystemTheme(media.matches);

  const apply = () => {
    active =
      preference === "system" ? resolveSystemTheme(media.matches) : preference;
    const theme = themes.find((candidate) => candidate.id === active);
    if (theme === undefined) throw new Error(`unknown theme: ${active}`);
    document.documentElement.dataset.theme = active;
    document.documentElement.style.colorScheme = theme.appearance;
  };
  const systemChanged = () => {
    if (preference === "system") apply();
  };

  media.addEventListener("change", systemChanged);
  apply();
  return {
    activeTheme: () => active,
    setPreference(nextPreference) {
      preference = nextPreference;
      apply();
    },
    dispose() {
      media.removeEventListener("change", systemChanged);
      style.remove();
    },
  };
}

function resolveSystemTheme(dark: boolean): ThemeId {
  const id = dark ? "lounge-night" : "lounge";
  const theme = themes.find((candidate) => candidate.id === id);
  if (theme === undefined) throw new Error(`missing system theme: ${id}`);
  return theme.id;
}
