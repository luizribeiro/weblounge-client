import { createSignal, onCleanup, onMount } from "solid-js";
import { t } from "../../strings";
import { trapTab } from "../../ui/focus-trap";
import { formatTime } from "../../ui/format-time";
import { afterStartStatePaints } from "../../ui/transform-motion";
import styles from "./ImageViewer.module.css";
import type { ImageViewerRequest } from "./image-viewer-request";
import { openPhotoSwipe, type PhotoSwipeViewer } from "./photoswipe-viewer";
import { viewerCommand } from "./viewer-keys";

type ViewerState = "opening" | "open" | "closing";

export default function ImageViewer(props: {
  readonly onClosed: () => void;
  readonly request: ImageViewerRequest;
}) {
  const [state, setState] = createSignal<ViewerState>("opening");
  const [announcement, setAnnouncement] = createSignal("");
  let dialog: HTMLDivElement | undefined;
  let stage: HTMLDivElement | undefined;
  let fitBox: HTMLDivElement | undefined;
  let viewer: PhotoSwipeViewer | undefined;
  let restoreInert = () => {};
  let cancelReveal = () => {};
  const label = () => t("image_viewer.label", { nick: props.request.author });

  onMount(() => {
    if (dialog === undefined || stage === undefined || fitBox === undefined)
      return;
    restoreInert = makeSiblingsInert(dialog);
    document.addEventListener("keydown", keydown, true);
    dialog.focus({ preventScroll: true });
    viewer = openPhotoSwipe({
      fitBox,
      host: stage,
      image: props.request,
      onClosing: () => setState("closing"),
      onDestroyed: props.onClosed,
    });
    cancelReveal = afterStartStatePaints(() => setState("open"));
    setAnnouncement(t("image_viewer.status", { nick: props.request.author }));
  });
  onCleanup(() => {
    document.removeEventListener("keydown", keydown, true);
    cancelReveal();
    viewer?.destroy();
    restoreInert();
    const origin = props.request.origin;
    queueMicrotask(() => {
      if (origin.isConnected) origin.focus({ preventScroll: true });
    });
  });

  // Captured at the document: the modal owns every key wherever focus lands,
  // so the shell's shortcuts never act behind it.
  const keydown = (event: KeyboardEvent) => {
    event.stopPropagation();
    const command = viewerCommand(event);
    if (command !== undefined) {
      event.preventDefault();
      viewer?.run(command);
      return;
    }
    trapTab(event, dialog);
  };

  return (
    <div
      aria-label={label()}
      aria-modal="true"
      class={styles.viewer}
      data-image-viewer={state()}
      ref={dialog}
      role="dialog"
      tabIndex={-1}
    >
      <div class={styles.stage} ref={stage} />
      <div aria-hidden="true" class={styles.fitBox} ref={fitBox} />
      <header class={styles.bar}>
        <div class={styles.identity}>
          <span class={styles.author}>{props.request.author}</span>
          <time
            class={styles.time}
            dateTime={new Date(props.request.time).toISOString()}
          >
            {formatTime(props.request.time)}
          </time>
        </div>
        <a
          class={styles.original}
          draggable={false}
          href={props.request.url}
          rel="noopener noreferrer"
          target="_blank"
        >
          {t("image_viewer.open_original")}
        </a>
        <button
          aria-label={t("image_viewer.close")}
          class={styles.close}
          onClick={() => viewer?.close()}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </header>
      <p class="visually-hidden" role="status">
        {announcement()}
      </p>
    </div>
  );
}

function makeSiblingsInert(element: HTMLElement): () => void {
  const siblings = [...(element.parentElement?.children ?? [])].filter(
    (sibling): sibling is HTMLElement =>
      sibling !== element && sibling instanceof HTMLElement && !sibling.inert,
  );
  for (const sibling of siblings) sibling.inert = true;
  return () => {
    for (const sibling of siblings) sibling.inert = false;
  };
}
