import { onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { t } from "../../strings";
import { returnFocus } from "../../ui/focus-return";
import { trapTab } from "../../ui/focus-trap";
import { followAnchor } from "../../ui/follow-anchor";
import { pickerPosition } from "./picker-position";
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
    if (dialog !== undefined) {
      const opened = dialog;
      const follow = () => place(opened, props.invoker);
      follow();
      onCleanup(followAnchor(props.invoker, follow, close));
    }
    search?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (dialog?.contains(target) !== true && !props.invoker.contains(target))
        props.onClose();
    };
    document.addEventListener("pointerdown", dismiss);
    onCleanup(() => document.removeEventListener("pointerdown", dismiss));
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

function place(dialog: HTMLElement, invoker: HTMLElement): void {
  const position = pickerPosition(
    invoker.getBoundingClientRect(),
    dialog.getBoundingClientRect(),
    window,
  );
  dialog.style.setProperty("--wl-reaction-picker-left", `${position.left}px`);
  dialog.style.setProperty("--wl-reaction-picker-top", `${position.top}px`);
}
