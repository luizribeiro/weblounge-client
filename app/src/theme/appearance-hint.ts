import { isRecord } from "../engine/decode-primitives";
import { decodeSettings } from "../engine/decodeSettings";
import type { AppSettings } from "../engine/generated/AppSettings";
import { resolveTheme } from "./resolve-theme";

export const appearanceHintKey = "weblounge:appearance";
const hintVersion = 1;

export function readAppearanceHint(
  storage: () => Pick<Storage, "getItem">,
): AppSettings | undefined {
  try {
    const value: unknown = JSON.parse(
      storage().getItem(appearanceHintKey) ?? "null",
    );
    if (!isRecord(value) || value.version !== hintVersion) return undefined;
    return decodeSettings({ app: value })?.app;
  } catch {
    return undefined;
  }
}

export function writeAppearanceHint(
  storage: () => Pick<Storage, "setItem">,
  settings: AppSettings,
): void {
  try {
    storage().setItem(
      appearanceHintKey,
      JSON.stringify({ version: hintVersion, ...settings }),
    );
  } catch {
    // Storage can be full or blocked; the engine still owns the setting.
  }
}

export function applyAppearanceHint(
  root: HTMLElement,
  hint: AppSettings | undefined,
  systemDark: boolean,
): void {
  if (hint === undefined) return;
  root.dataset.theme = resolveTheme(hint.theme, systemDark);
  root.dataset.messageDensity = hint.message_density;
}
