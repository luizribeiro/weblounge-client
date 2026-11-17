import { createUniqueId, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import type { UnverifiedSender } from "../../engine/protocol";
import { returnFocus } from "../../ui/focus-return";
import { onPointerDownOutside } from "../../ui/outside-pointer";
import { anchorPopover } from "./anchored-popover";
import { UnverifiedSenderExplanation } from "./UnverifiedSenderExplanation";
import styles from "./UnverifiedSenderPopover.module.css";

export function UnverifiedSenderPopover(props: {
  readonly invoker: HTMLElement;
  readonly reason: UnverifiedSender;
  readonly onClose: () => void;
}) {
  const titleId = createUniqueId();
  let dialog: HTMLDivElement | undefined;

  onMount(() => {
    if (dialog === undefined) return;
    onCleanup(
      anchorPopover(
        dialog,
        props.invoker,
        "--wl-unverified",
        props.onClose,
        "start",
      ),
    );
    dialog.focus({ preventScroll: true });
    onPointerDownOutside(() => [dialog, props.invoker], props.onClose);
  });

  return (
    <Portal>
      <div
        aria-labelledby={titleId}
        class={styles.popover}
        data-unverified-explanation="true"
        on:focusout={(event) => {
          const next = event.relatedTarget;
          if (
            next instanceof Node &&
            dialog?.contains(next) !== true &&
            !props.invoker.contains(next)
          )
            props.onClose();
        }}
        on:keydown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          returnFocus(props.invoker);
          props.onClose();
        }}
        ref={dialog}
        role="dialog"
        tabIndex={-1}
      >
        <UnverifiedSenderExplanation reason={props.reason} titleId={titleId} />
      </div>
    </Portal>
  );
}
