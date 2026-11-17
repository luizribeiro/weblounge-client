import { createSignal, createUniqueId, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { UnverifiedSender } from "../../engine/protocol";
import { t } from "../../strings";
import { returnFocus } from "../../ui/focus-return";
import { MobileSheet } from "../../ui/MobileSheet";
import { UnverifiedSenderExplanation } from "./UnverifiedSenderExplanation";
import styles from "./UnverifiedSenderMark.module.css";
import { UnverifiedSenderPopover } from "./UnverifiedSenderPopover";

export function UnverifiedSenderMark(props: {
  readonly reason: UnverifiedSender | undefined;
  readonly presentation: "desktop" | "mobile";
}) {
  const tooltipId = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [hintDismissed, setHintDismissed] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  const closeSheet = () => {
    setOpen(false);
    returnFocus(button ?? null);
  };
  return (
    <Show when={props.reason}>
      {(reason) => (
        <span
          class={styles.mark}
          data-hint-dismissed={hintDismissed() || undefined}
          data-presentation={props.presentation}
        >
          <button
            aria-describedby={
              props.presentation === "desktop" ? tooltipId : undefined
            }
            aria-expanded={open()}
            aria-haspopup="dialog"
            aria-label={t("messages.unverified_sender")}
            class={styles.button}
            data-unverified-mark="true"
            onBlur={() => setHintDismissed(false)}
            onMouseLeave={() => setHintDismissed(false)}
            onClick={(event) => {
              event.stopPropagation();
              setOpen((current) => !current);
            }}
            on:keydown={(event) => {
              if (event.key !== "Escape" || open() || hintDismissed()) return;
              event.stopPropagation();
              setHintDismissed(true);
            }}
            // The row's long press opens the message sheet; a press on the mark is for the mark.
            on:pointerdown={(event) => event.stopPropagation()}
            ref={button}
            type="button"
          >
            ?
          </button>
          <Show when={props.presentation === "desktop"}>
            <span class={styles.tooltip} id={tooltipId} role="tooltip">
              {t("messages.unverified_sender.hint")}
            </span>
          </Show>
          <Show when={open() && button}>
            {(invoker) =>
              props.presentation === "mobile" ? (
                <Portal>
                  <MobileSheet
                    label={t("messages.unverified_sender")}
                    onDismiss={closeSheet}
                  >
                    <UnverifiedSenderExplanation reason={reason()} />
                  </MobileSheet>
                </Portal>
              ) : (
                <UnverifiedSenderPopover
                  invoker={invoker()}
                  onClose={() => setOpen(false)}
                  reason={reason()}
                />
              )
            }
          </Show>
        </span>
      )}
    </Show>
  );
}
