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
  const systemDescriptionId = createUniqueId();
  return (
    <RadioGroup
      choiceClass={styles.card}
      choiceDescribedBy={(preference) =>
        preference === "system" ? systemDescriptionId : undefined
      }
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
            <Show when={preference === "system"}>
              <small id={systemDescriptionId}>
                {t("settings.theme.system_description")}
              </small>
            </Show>
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

export function themeName(preference: ThemePreference): string {
  return preference === "system"
    ? t("settings.theme.system")
    : themeFor(preference, false).name;
}
