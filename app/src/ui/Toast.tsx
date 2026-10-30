import { createEffect, onCleanup } from "solid-js";
import type { ActionId } from "../actions/action-registry";
import { t } from "../features/composer/strings";
import type { ToastNotice } from "./notices";
import styles from "./Toast.module.css";

interface ToastProps {
  readonly notice: ToastNotice;
  readonly onAction: (id: ActionId) => void;
  readonly onDismiss: (id: string) => void;
}

const lifetimeMilliseconds = 6_000;

export function Toast(props: ToastProps) {
  let remaining = lifetimeMilliseconds;
  let startedAt = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let surface: HTMLDivElement | undefined;

  const clear = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
  };
  const resume = () => {
    if (timeout !== undefined) return;
    startedAt = performance.now();
    const id = props.notice.id;
    timeout = setTimeout(() => props.onDismiss(id), remaining);
  };
  const pause = () => {
    if (timeout === undefined) return;
    remaining = Math.max(0, remaining - (performance.now() - startedAt));
    clear();
  };

  createEffect(() => {
    props.notice.id;
    clear();
    remaining = lifetimeMilliseconds;
    resume();
  });
  onCleanup(clear);

  return (
    <div class={styles.surface}>
      <div
        class={styles.toast}
        data-toast="true"
        data-tone={props.notice.tone}
        onFocusIn={pause}
        onFocusOut={(event) => {
          if (!surface?.contains(event.relatedTarget as Node | null)) resume();
        }}
        onPointerEnter={pause}
        onPointerLeave={resume}
        ref={surface}
        role="status"
      >
        <span>{t(props.notice.message.key, props.notice.message.values)}</span>
        {props.notice.action !== undefined && (
          <button
            class={styles.action}
            onClick={() => {
              const action = props.notice.action;
              if (action !== undefined) props.onAction(action.run);
              props.onDismiss(props.notice.id);
            }}
            type="button"
          >
            {t(props.notice.action.label)}
          </button>
        )}
      </div>
    </div>
  );
}
