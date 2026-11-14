import type { CommandSpec } from "../../engine/protocol";
import { t } from "../../strings";
import type { UploadFailure } from "../uploads/types";
import { commandForInput } from "./command-input";

export type AttachmentFailure =
  | UploadFailure
  | { readonly kind: "command" }
  | { readonly kind: "send_rejected" };

export type AttachmentState =
  | { readonly status: "ready" }
  | { readonly status: "uploading"; readonly progress: number }
  | { readonly status: "uploaded"; readonly url: string }
  | {
      readonly status: "failed";
      readonly failure: AttachmentFailure;
      readonly url?: string;
    };

export interface Attachment {
  readonly file: File;
  readonly previewUrl: string;
  readonly state: AttachmentState;
}

/** The single message U3 sends: the caption, a space, the URL. */
export function messageWithImage(caption: string, url: string): string {
  const text = caption.trimEnd();
  return text.trim() === "" ? url : `${text} ${url}`;
}

/** Plain text, `//literal`, `/me` and `/say` can carry an image; other commands cannot. */
export function captionTakesImage(
  caption: string,
  commands: readonly CommandSpec[],
): boolean {
  const input = caption.trimStart();
  if (!input.startsWith("/") || input.startsWith("//")) return true;
  const name = commandForInput(input, commands)?.name;
  return name === "me" || name === "say";
}

export function attachmentLabel(bytes: number): string {
  return t("upload.label", { size: formatBytes(bytes) });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function failureMessage(failure: AttachmentFailure): string {
  switch (failure.kind) {
    case "too_large":
      return failure.limit === undefined
        ? t("upload.failed.too_large")
        : t("upload.failed.too_large_limit", {
            limit: formatBytes(failure.limit),
          });
    case "failed":
      return failure.detail === undefined
        ? t("upload.failed.generic")
        : t("upload.failed.detail", { detail: failure.detail });
    case "network":
    case "aborted":
      return t("upload.failed.generic");
    case "command":
      return t("upload.failed.command");
    case "send_rejected":
      return t("upload.failed.send");
    case "offline":
    case "unavailable":
    case "declined":
    case "unauthorized":
    case "unsupported_type":
    case "undecodable":
    case "rate_limited":
    case "quota_full":
      return t(`upload.failed.${failure.kind}`);
  }
}
