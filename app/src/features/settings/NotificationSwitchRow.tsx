import { type MessageKey, t } from "../../strings";
import {
  type NotificationSwitch,
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

interface SwitchRowView {
  readonly label: MessageKey;
  readonly description: MessageKey;
  readonly note: SettingNote | undefined;
  readonly checked: boolean | undefined;
  readonly blocked: boolean;
  readonly onToggle: (on: boolean) => void;
}

function blockedNote(
  blockedIn: PushBlockedIn,
  openSettings?: () => void,
): SettingNote {
  return {
    text: t(blockedLines[blockedIn]),
    tone: "neutral",
    action:
      openSettings === undefined
        ? undefined
        : { label: t("settings.push.open_settings"), run: openSettings },
  };
}

function pushSettingNote(push: PushSettings): SettingNote | undefined {
  const note = pushNote(push);
  if (note === undefined) return undefined;
  if (note.kind === "failed")
    return {
      text: t("settings.push.failed"),
      tone: "error",
      action: { label: t("settings.push.retry"), run: () => push.onRetry() },
    };
  return blockedNote(
    note.in,
    note.openSettings ? () => push.onOpenSystemSettings?.() : undefined,
  );
}

function switchRowView(notifications: NotificationSwitch): SwitchRowView {
  switch (notifications.kind) {
    case "push": {
      const { push } = notifications;
      return {
        label: "settings.push",
        description: "settings.push.description",
        note: pushSettingNote(push),
        checked: pushSwitchChecked(push.status),
        blocked: push.status === "blocked",
        onToggle: push.onToggle,
      };
    }
  }
}

export function NotificationSwitchRow(props: {
  readonly notifications: NotificationSwitch;
}) {
  const view = () => switchRowView(props.notifications);
  return (
    <>
      <h3 class={styles.section}>{t("settings.this_device")}</h3>
      <SettingRow
        control="switch"
        description={t(view().description)}
        label={t(view().label)}
        note={view().note}
      >
        {(ids) => (
          <SettingSwitch
            {...ids}
            checked={view().checked}
            disabled={view().blocked}
            onChange={(on) => view().onToggle(on)}
          />
        )}
      </SettingRow>
    </>
  );
}
