import { Show } from "solid-js";
import type { BufferProjection } from "../../engine/protocol";
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
            Trust new identity
          </button>
          <button onClick={() => props.onDefer(props.buffer.id)} type="button">
            Not now
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

export function directIdentityBlockedReason(
  buffer: BufferProjection,
): string | undefined {
  if (
    buffer.direct_identity === "different_account" ||
    buffer.direct_identity === "deferred_different_account"
  )
    return `Messages are blocked because this isn't the same ${buffer.title}.`;
  if (
    buffer.direct_identity === "cannot_verify" ||
    buffer.direct_identity === "deferred_cannot_verify"
  )
    return `Messages are blocked until ${buffer.title}'s identity can be verified.`;
  return undefined;
}

function mismatchMessage(buffer: BufferProjection): string | undefined {
  if (buffer.direct_identity === "different_account")
    return `This isn't the same ${buffer.title} — different account`;
  if (buffer.direct_identity === "cannot_verify")
    return `Can't verify this is the same ${buffer.title}`;
  return undefined;
}
