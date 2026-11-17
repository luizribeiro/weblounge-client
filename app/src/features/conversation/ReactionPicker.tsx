import { onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { t } from "../../strings";
import { returnFocus } from "../../ui/focus-return";
import { trapTab } from "../../ui/focus-trap";
import { onPointerDownOutside } from "../../ui/outside-pointer";
import { anchorPopover } from "./anchored-popover";
import styles from "./ReactionPicker.module.css";
import { ReactionPickerPanel } from "./ReactionPickerPanel";

export function ReactionPicker(props: {
  readonly invoker: HTMLElement;
  readonly nick: string;
  readonly mine: ReadonlySet<string>;
  readonly onPick: (reaction: string) => void;
  readonly onClose: () => void;
}) {
  let dialog: HTMLDivElement | undefined;
  let search: HTMLInputElement | undefined;

  const close = () => {
    returnFocus(props.invoker);
    props.onClose();
  };
  const pick = (reaction: string) => {
    props.invoker.focus({ preventScroll: true });
    if (!props.mine.has(reaction)) props.onPick(reaction);
    props.onClose();
  };

  onMount(() => {
    if (dialog !== undefined)
      onCleanup(
        anchorPopover(dialog, props.invoker, "--wl-reaction-picker", close),
      );
    search?.focus({ preventScroll: true });
    onPointerDownOutside(
      () => [dialog, props.invoker],
      () => props.onClose(),
    );
  });

  return (
    <Portal>
      <div
        aria-label={t("reaction.add")}
        aria-modal="true"
        class={styles.picker}
        data-reaction-picker="true"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else trapTab(event, dialog);
        }}
        ref={dialog}
        role="dialog"
      >
        <ReactionPickerPanel
          mine={props.mine}
          nick={props.nick}
          onPick={pick}
          searchRef={(element) => {
            search = element;
          }}
        />
      </div>
    </Portal>
  );
}
