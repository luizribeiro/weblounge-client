import { isRecord } from "../engine/decode-primitives";
import { type Appearance, decodeAppearance } from "../engine/decodeSettings";
import { resolveTheme } from "./resolve-theme";

export const appearanceHintKey = "weblounge:appearance";
const hintVersion = 1;

export function readAppearanceHint(
  storage: () => Pick<Storage, "getItem">,
): Appearance | undefined {
  try {
    const value: unknown = JSON.parse(
      storage().getItem(appearanceHintKey) ?? "null",
    );
    if (!isRecord(value) || value.version !== hintVersion) return undefined;
    return decodeAppearance(value);
  } catch {
    return undefined;
  }
}

export function writeAppearanceHint(
  storage: () => Pick<Storage, "setItem">,
  { theme, message_density }: Appearance,
): void {
  try {
    storage().setItem(
      appearanceHintKey,
      JSON.stringify({ version: hintVersion, theme, message_density }),
    );
  } catch {
    // Storage can be full or blocked; the engine still owns the setting.
  }
}

export function applyAppearanceHint(
  root: HTMLElement,
  hint: Appearance | undefined,
  systemDark: boolean,
): void {
  if (hint === undefined) return;
  root.dataset.theme = resolveTheme(hint.theme, systemDark);
  root.dataset.messageDensity = hint.message_density;
}
