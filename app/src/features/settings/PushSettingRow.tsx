import { type MessageKey, t } from "../../strings";
import {
  type PushBlockedIn,
  type PushSettings,
  pushNote,
  pushSwitchChecked,
} from "./push-settings";
import { type SettingNote, SettingRow } from "./SettingRow";
import { SettingSwitch } from "./SettingSwitch";
import styles from "./SettingsHeading.module.css";

const blockedLines: Readonly<Record<PushBlockedIn, MessageKey>> = {
  ios: "settings.push.blocked.ios",
  macos: "settings.push.blocked.macos",
  browser: "settings.push.blocked.browser",
};

function settingNote(push: PushSettings): SettingNote | undefined {
  const note = pushNote(push);
  if (note === undefined) return undefined;
  if (note.kind === "failed")
    return {
      text: t("settings.push.failed"),
      tone: "error",
      action: { label: t("settings.push.retry"), run: () => push.onRetry() },
    };
  return {
    text: t(blockedLines[note.in]),
    tone: "neutral",
    action: note.openSettings
      ? {
          label: t("settings.push.open_settings"),
          run: () => push.onOpenSystemSettings?.(),
        }
      : undefined,
  };
}

export function PushSettingRow(props: { readonly push: PushSettings }) {
  return (
    <>
      <h3 class={styles.section}>{t("settings.this_device")}</h3>
      <SettingRow
        control="switch"
        description={t("settings.push.description")}
        label={t("settings.push")}
        note={settingNote(props.push)}
      >
        {(ids) => (
          <SettingSwitch
            {...ids}
            checked={pushSwitchChecked(props.push.status)}
            disabled={props.push.status === "blocked"}
            onChange={(on) => props.push.onToggle(on)}
          />
        )}
      </SettingRow>
    </>
  );
}
