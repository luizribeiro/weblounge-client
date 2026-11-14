import { createUniqueId, type JSX, Show } from "solid-js";
import { themePreferences } from "../../engine/decodeSettings";
import type { ThemePreference } from "../../engine/generated/ThemePreference";
import { t } from "../../strings";
import { resolveTheme } from "../../theme/resolve-theme";
import { type ThemeDefinition, themes } from "../../theme/theme-registry";
import { RadioGroup } from "./RadioGroup";
import styles from "./ThemeCards.module.css";

interface ThemeCardsProps {
  readonly labelledBy: string;
  readonly value: ThemePreference | undefined;
  readonly onChange: (value: ThemePreference) => void;
}

export function ThemeCards(props: ThemeCardsProps) {
  const descriptionId = createUniqueId();
  const describedBy = (preference: ThemePreference) =>
    `${descriptionId}-${preference}`;
  return (
    <RadioGroup
      choiceClass={styles.card}
      choiceDescribedBy={describedBy}
      choiceLabel={themeName}
      class={styles.cards}
      data-horizontal-scroll="true"
      labelledBy={props.labelledBy}
      onChange={props.onChange}
      value={props.value}
      values={themePreferences}
    >
      {(preference) => (
        <>
          <span aria-hidden="true" class={styles.preview}>
            <ThemePreview theme={themeFor(preference, false)} />
            <Show when={preference === "system"}>
              <span class={styles.dark}>
                <ThemePreview theme={themeFor(preference, true)} />
              </span>
            </Show>
          </span>
          <span aria-hidden="true" class={styles.name}>
            <b>{themeName(preference)}</b>
            <small id={describedBy(preference)}>
              {themeDescription(preference)}
            </small>
          </span>
        </>
      )}
    </RadioGroup>
  );
}

function ThemePreview(props: { readonly theme: ThemeDefinition }) {
  return (
    <span
      class={styles.miniature}
      data-preview-theme={props.theme.id}
      style={previewTokens(props.theme)}
    >
      <span class={styles.miniPanel}>
        <span class={styles.logo} />
        <span class={styles.mutedBar} />
        <span class={styles.selectedBar} />
      </span>
      <span class={styles.miniMain}>
        <span class={styles.textBar} />
        <span class={styles.shortTextBar} />
        <span class={styles.input}>
          <span class={styles.send} />
        </span>
      </span>
    </span>
  );
}

function previewTokens(theme: ThemeDefinition): JSX.CSSProperties {
  const { colors } = theme;
  return {
    "--wl-preview-panel": colors.panel,
    "--wl-preview-panel-muted": colors.panelMuted,
    "--wl-preview-logo": colors.panelFg,
    "--wl-preview-selection": colors.selection,
    "--wl-preview-surface": colors.bg,
    "--wl-preview-fg": colors.fg,
    "--wl-preview-border": colors.border,
    "--wl-preview-input": colors.inputBg,
    "--wl-preview-accent": colors.accent,
    "--wl-preview-radius": theme.shape.control,
  };
}

function themeFor(
  preference: ThemePreference,
  systemDark: boolean,
): ThemeDefinition {
  const id = resolveTheme(preference, systemDark);
  const theme = themes.find((candidate) => candidate.id === id);
  if (theme === undefined) throw new Error(`unknown theme: ${id}`);
  return theme;
}

function themeDescription(preference: ThemePreference): string {
  return preference === "system"
    ? t("settings.theme.system_description")
    : themeFor(preference, false).description;
}

export function themeName(preference: ThemePreference): string {
  return preference === "system"
    ? t("settings.theme.system")
    : themeFor(preference, false).name;
}
