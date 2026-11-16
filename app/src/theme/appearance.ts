import { densityFor, installDensity } from "../density/density";
import type { Appearance } from "../engine/decodeSettings";
import { readAppearanceHint, writeAppearanceHint } from "./appearance-hint";
import { installTheme } from "./theme-controller";
import type { ThemeDefinition } from "./theme-registry";

export interface AppearanceController {
  apply(appearance: Appearance): void;
  setSystemDark(dark: boolean): void;
  dispose(): void;
}

export function installAppearance(
  document: Document,
  systemDark: boolean,
  storage: () => Storage,
  onApply?: (theme: ThemeDefinition) => void,
): AppearanceController {
  const remembered = readAppearanceHint(storage);
  const theme = installTheme(document, systemDark, remembered?.theme, onApply);
  const removeDensity = installDensity(
    document,
    densityFor(remembered?.message_density),
  );
  return {
    apply(appearance) {
      theme.setPreference(appearance.theme);
      installDensity(document, densityFor(appearance.message_density));
      writeAppearanceHint(storage, appearance);
    },
    setSystemDark: (dark) => theme.setSystemDark(dark),
    dispose() {
      theme.dispose();
      removeDensity();
    },
  };
}
