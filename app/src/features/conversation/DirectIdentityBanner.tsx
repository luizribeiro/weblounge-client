import { Show } from "solid-js";
import type { BufferProjection } from "../../engine/protocol";
import { t } from "../../strings";
import styles from "./DirectIdentityBanner.module.css";

interface DirectIdentityBannerProps {
  readonly buffer: BufferProjection;
  readonly onDefer: (bufferId: number) => void;
  readonly onTrust: (bufferId: number) => void;
}

export function DirectIdentityBanner(props: DirectIdentityBannerProps) {
  const message = () => mismatchMessage(props.buffer);
  return (
    <Show when={message()} keyed>
      {(text) => (
        <div
          class={styles.banner}
          data-direct-identity-banner="true"
          role="alert"
        >
          <span>{text}</span>
          <button onClick={() => props.onTrust(props.buffer.id)} type="button">
            {t("direct_identity.trust")}
          </button>
          <button onClick={() => props.onDefer(props.buffer.id)} type="button">
            {t("direct_identity.defer")}
          </button>
        </div>
      )}
    </Show>
  );
}

export function directIdentityBlocked(buffer: BufferProjection): boolean {
  return (
    buffer.direct_identity === "different_account" ||
    buffer.direct_identity === "cannot_verify" ||
    buffer.direct_identity === "deferred_different_account" ||
    buffer.direct_identity === "deferred_cannot_verify"
  );
}

function mismatchMessage(buffer: BufferProjection): string | undefined {
  if (buffer.direct_identity === "different_account")
    return t("direct_identity.changed", { nick: buffer.title });
  if (buffer.direct_identity === "cannot_verify")
    return t("direct_identity.cannot_verify", { nick: buffer.title });
  return undefined;
}
