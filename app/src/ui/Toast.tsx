import { createEffect, onCleanup } from "solid-js";
import styles from "./Toast.module.css";

export interface ToastNotice {
  readonly id: string;
  readonly message: string;
  readonly action?:
    | { readonly label: string; readonly run: () => void }
    | undefined;
}

interface ToastProps {
  readonly notice: ToastNotice;
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
        onFocusIn={pause}
        onFocusOut={(event) => {
          if (!surface?.contains(event.relatedTarget as Node | null)) resume();
        }}
        onPointerEnter={pause}
        onPointerLeave={resume}
        ref={surface}
        role="status"
      >
        <span>{props.notice.message}</span>
        {props.notice.action !== undefined && (
          <button
            class={styles.action}
            onClick={() => {
              props.notice.action?.run();
              props.onDismiss(props.notice.id);
            }}
            type="button"
          >
            {props.notice.action.label}
          </button>
        )}
      </div>
    </div>
  );
}
