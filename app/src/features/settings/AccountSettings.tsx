import { createSignal, Show } from "solid-js";
import { platformEnvironment } from "../../platform/environment";
import { t } from "../../strings";
import { ExternalLinkIcon } from "../../ui/icons/ExternalLinkIcon";
import { InlineConfirmation } from "../composer/InlineConfirmation";
import styles from "./AccountSettings.module.css";
import { SettingRow } from "./SettingRow";
import rowStyles from "./SettingRow.module.css";
import type { AccountControls, SettingsPageProps } from "./settings-page-props";

export function membersSiteName(account: AccountControls): string {
  return new URL(account.membersSite).host;
}

export function AccountSettings(props: SettingsPageProps) {
  return (
    <Show when={props.account}>
      {(account) => <AccountRows account={account()} />}
    </Show>
  );
}

type SignOutStep = "idle" | "confirming" | "signing_out";

function AccountRows(props: { readonly account: AccountControls }) {
  const platform = platformEnvironment();
  const [step, setStep] = createSignal<SignOutStep>("idle");
  let signOutButton: HTMLButtonElement | undefined;
  let confirmButton: HTMLButtonElement | undefined;
  const focusUnlessTouch = (target: HTMLButtonElement | undefined) => {
    if (platform.environment().input !== "touch")
      queueMicrotask(() => target?.focus());
  };
  const confirm = () => {
    setStep("confirming");
    focusUnlessTouch(confirmButton);
  };
  const cancel = () => {
    setStep("idle");
    focusUnlessTouch(signOutButton);
  };
  const signOut = () => {
    setStep("signing_out");
    props.account.onSignOut();
  };
  return (
    <>
      <SettingRow
        control="action"
        description={t("settings.account.members.description")}
        label={t("settings.account.members")}
      >
        {(ids) => (
          <a
            aria-describedby={ids.describedBy}
            class={`${rowStyles.noteAction} ${styles.action}`}
            draggable={false}
            href={props.account.membersSite}
            rel="noopener noreferrer"
            target="_blank"
          >
            {membersSiteName(props.account)}
            <ExternalLinkIcon />
          </a>
        )}
      </SettingRow>
      <SettingRow
        control="action"
        description={t("settings.account.sign_out.description")}
        label={t("settings.account.sign_out")}
      >
        {(ids) => (
          <button
            aria-describedby={ids.describedBy}
            class={`${rowStyles.noteAction} ${styles.action} ${styles.signOut}`}
            disabled={step() === "signing_out"}
            onClick={confirm}
            ref={signOutButton}
            type="button"
          >
            {step() === "signing_out"
              ? t("settings.account.signing_out")
              : t("settings.account.sign_out")}
          </button>
        )}
      </SettingRow>
      <Show when={step() === "confirming"}>
        <div class={styles.confirmation}>
          <InlineConfirmation
            action={t("settings.account.sign_out")}
            confirmRef={(button) => {
              confirmButton = button;
            }}
            label={t("settings.account.sign_out")}
            message={t("settings.account.sign_out.confirm")}
            onCancel={cancel}
            onConfirm={signOut}
          />
        </div>
      </Show>
    </>
  );
}
