import { createSignal, type JSX } from "solid-js";
import { t } from "../strings";
import styles from "./ChairFlip.module.css";

interface ChairFlipProps {
  readonly class: string | undefined;
  readonly front: (faceClass: string) => JSX.Element;
}

export function ChairFlip(props: ChairFlipProps) {
  const [flipped, setFlipped] = createSignal(false);

  return (
    <button
      aria-label={t("action.flip_logo")}
      aria-pressed={flipped()}
      class={[styles.flip, props.class].filter(Boolean).join(" ")}
      data-chair-flip="true"
      onClick={() => setFlipped((current) => !current)}
      onMouseDown={keepFocusWhereItIs}
      type="button"
    >
      {props.front(`${styles.face} ${styles.front}`)}
      <span aria-hidden="true" class={`${styles.face} ${styles.back}`} />
    </button>
  );
}

function keepFocusWhereItIs(event: MouseEvent): void {
  event.preventDefault();
}
