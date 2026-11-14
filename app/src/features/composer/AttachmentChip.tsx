import { t } from "../../strings";
import { Line } from "../../ui/Line";
import styles from "./AttachmentChip.module.css";
import { type Attachment, attachmentLabel, failureMessage } from "./attachment";

interface AttachmentChipProps {
  readonly attachment: Attachment;
  readonly onRemove: () => void;
  readonly onRetry: () => void;
}

export function AttachmentChip(props: AttachmentChipProps) {
  const state = () => props.attachment.state;
  const status = () => {
    const current = state();
    switch (current.status) {
      case "ready":
        return "";
      case "uploading":
        return t("upload.uploading");
      case "uploaded":
        return t("upload.uploaded");
      case "failed":
        return failureMessage(current.failure);
    }
  };
  const progress = () => {
    const current = state();
    return current.status === "uploading" ? current.progress : undefined;
  };
  return (
    <div
      aria-busy={state().status === "uploading"}
      class={styles.chip}
      data-attachment-chip="true"
      data-state={state().status}
    >
      <img
        alt=""
        class={styles.thumb}
        data-attachment-thumbnail="true"
        draggable={false}
        src={props.attachment.previewUrl}
      />
      <span class={styles.text}>
        <Line class={styles.label}>
          {attachmentLabel(props.attachment.file.size)}
        </Line>
        {status() !== "" && (
          <Line class={styles.status} role="status">
            {status()}
          </Line>
        )}
      </span>
      {state().status === "failed" && (
        <button
          class={styles.retry}
          onClick={() => props.onRetry()}
          onPointerDown={(event) => event.preventDefault()}
          type="button"
        >
          {t("common.retry")}
        </button>
      )}
      <button
        aria-label={t("upload.remove")}
        class={styles.remove}
        onClick={() => props.onRemove()}
        onPointerDown={(event) => event.preventDefault()}
        type="button"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
      {progress() !== undefined && (
        <span class={styles.progress} data-upload-progress={progress()}>
          <span
            class={styles.bar}
            style={{ "--wl-upload-progress": String(progress() ?? 0) }}
          />
        </span>
      )}
    </div>
  );
}
