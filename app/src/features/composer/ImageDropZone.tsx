import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { t } from "../../strings";
import { ErrorDialog } from "../../ui/ErrorDialog";
import { imageRejectionMessage } from "./attachment";
import styles from "./ImageDropZone.module.css";
import {
  type DropRefusal,
  type DropTargets,
  dropFiles,
  imageDropTargets,
  shortFileName,
} from "./image-drop";

interface ImageDropZoneProps {
  readonly targets?: DropTargets;
}

/** Takes an image dropped anywhere on the window to the open conversation's composer. */
export function ImageDropZone(props: ImageDropZoneProps) {
  const targets = () => props.targets ?? imageDropTargets;
  // dragleave fires for every element the pointer crosses, and WebKit gives every one a null
  // relatedTarget, so only the enter/leave balance says whether the drag is still over the window.
  const [depth, setDepth] = createSignal(0);
  const [blocked, setBlocked] = createSignal(false);
  const [refusal, setRefusal] = createSignal<DropRefusal>();
  const reset = () => setDepth(0);

  const enter = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (depth() === 0) setBlocked(modalOpen());
    setDepth((current) => current + 1);
  };
  const over = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setBlocked(modalOpen());
    if (event.dataTransfer !== null)
      event.dataTransfer.dropEffect = blocked() ? "none" : "copy";
  };
  const leave = (event: DragEvent) => {
    if (carriesFiles(event)) setDepth((current) => Math.max(0, current - 1));
  };
  const drop = (event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    reset();
    if (blocked() || modalOpen()) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    void dropFiles(files, targets().front()).then((refused) => {
      if (refused !== undefined) setRefusal(refused);
    });
  };
  const dismiss = () => {
    setRefusal(undefined);
    targets().front()?.focus();
  };

  onMount(() => {
    const listeners = [
      ["dragenter", enter],
      ["dragover", over],
      ["dragleave", leave],
      ["drop", drop],
    ] as const;
    for (const [type, listener] of listeners)
      window.addEventListener(type, listener);
    window.addEventListener("blur", reset);
    onCleanup(() => {
      for (const [type, listener] of listeners)
        window.removeEventListener(type, listener);
      window.removeEventListener("blur", reset);
    });
  });

  return (
    <>
      <Show when={depth() > 0 && !blocked()}>
        <div aria-hidden="true" class={styles.overlay} data-drop-overlay="true">
          <p class={styles.hint}>{t("upload.drop.hint")}</p>
        </div>
      </Show>
      <Show when={refusal()}>
        {(refused) => (
          <Portal>
            <ErrorDialog
              explanation={refusalExplanation(refused())}
              message={refusalTitle(refused())}
              onDismiss={dismiss}
            />
          </Portal>
        )}
      </Show>
    </>
  );
}

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

function modalOpen(): boolean {
  return document.querySelector("[aria-modal='true']") !== null;
}

function refusalTitle(refusal: DropRefusal): string {
  return refusal.name === undefined
    ? t("upload.drop.title_several")
    : t("upload.drop.title", { name: shortFileName(refusal.name) });
}

function refusalExplanation(refusal: DropRefusal): string {
  switch (refusal.reason) {
    case "several":
      return t("upload.drop.several");
    case "no_conversation":
      return t("upload.drop.no_conversation");
    case "closed":
      return t("upload.drop.closed");
    case "unavailable":
      return t("upload.unavailable");
    case "not_image":
    case "too_large":
    case "unreadable":
      return imageRejectionMessage(refusal.reason);
  }
}
