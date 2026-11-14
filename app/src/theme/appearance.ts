import { densityFor, installDensity } from "../density/density";
import type { AppSettings } from "../engine/generated/AppSettings";
import { readAppearanceHint, writeAppearanceHint } from "./appearance-hint";
import { installTheme } from "./theme-controller";

export interface AppearanceController {
  apply(appearance: AppSettings): void;
  setSystemDark(dark: boolean): void;
  dispose(): void;
}

export function installAppearance(
  document: Document,
  systemDark: boolean,
  storage: () => Storage,
): AppearanceController {
  const remembered = readAppearanceHint(storage);
  const theme = installTheme(document, systemDark, remembered?.theme);
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
