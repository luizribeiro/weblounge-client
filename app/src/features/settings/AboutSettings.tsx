import { createSignal, For, Show } from "solid-js";
import { buildVersion } from "../../build-version";
import { appTitle, useReleaseChannel } from "../../hosted/release-channel";
import { platformEnvironment } from "../../platform/environment";
import { hostShellIdentity } from "../../platform/host-shell";
import { userAgent } from "../../platform/user-agent";
import { type MessageKey, t } from "../../strings";
import { ChairMark } from "../../ui/ChairMark";
import styles from "./AboutSettings.module.css";
import { aboutFacts, debugInfoText } from "./about-facts";
import rowStyles from "./SettingRow.module.css";

type CopyResult = Extract<
  MessageKey,
  "settings.about.copied" | "settings.about.copy_failed"
>;

export function AboutSettings() {
  const channel = useReleaseChannel();
  const facts = () =>
    aboutFacts({
      build: buildVersion,
      channel: channel(),
      shell: hostShellIdentity(),
      display: platformEnvironment().environment().display,
    });
  const [result, setResult] = createSignal<CopyResult>();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(debugInfoText(facts(), userAgent()));
      setResult("settings.about.copied");
    } catch {
      setResult("settings.about.copy_failed");
    }
  };
  return (
    <>
      <div class={styles.brand}>
        <span aria-hidden="true" class={styles.tile}>
          <ChairMark class={styles.mark} />
        </span>
        <h3 class={styles.name}>{appTitle(channel())}</h3>
      </div>
      <dl class={styles.facts}>
        <For each={facts()}>
          {(fact) => (
            <div class={styles.fact}>
              <dt>{t(fact.label)}</dt>
              <dd>{fact.value}</dd>
            </div>
          )}
        </For>
      </dl>
      <div class={styles.actions}>
        <button
          class={rowStyles.noteAction}
          onClick={() => void copy()}
          type="button"
        >
          {t("settings.about.copy")}
        </button>
        <span
          class={rowStyles.statusText}
          data-tone={
            result() === "settings.about.copy_failed" ? "error" : "neutral"
          }
          role="status"
        >
          <Show when={result()} keyed>
            {(key) => t(key)}
          </Show>
        </span>
      </div>
    </>
  );
}
