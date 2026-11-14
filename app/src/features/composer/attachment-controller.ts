import { createSignal } from "solid-js";
import type { CommandSpec } from "../../engine/protocol";
import {
  createImagePreviewUrl,
  revokeImagePreviewUrl,
} from "../../platform/object-url";
import type {
  ApprovalAnswer,
  NetworkUploads,
  UploadFailure,
  UploadResult,
} from "../uploads/types";
import {
  type Attachment,
  type AttachmentFailure,
  type AttachmentState,
  captionTakesImage,
  messageWithImage,
} from "./attachment";

interface AttachmentControllerOptions {
  readonly uploads: () => NetworkUploads | undefined;
  readonly createUrl?: (file: File) => string;
  readonly revokeUrl?: (url: string) => void;
}

/** The password-release question an upload is waiting on (design 31, U1). */
export interface PendingApproval {
  readonly host: string;
  answer(answer: ApprovalAnswer): void;
}

export type AttachmentController = ReturnType<
  typeof createAttachmentController
>;

const declined: ApprovalAnswer = { allow: false, remember: false };

export function createAttachmentController(
  options: AttachmentControllerOptions,
) {
  const createUrl = options.createUrl ?? createImagePreviewUrl;
  const revokeUrl = options.revokeUrl ?? revokeImagePreviewUrl;
  const [attachment, setAttachment] = createSignal<Attachment>();
  const [pendingReplacement, setPendingReplacement] = createSignal<File>();
  const [pendingApproval, setPendingApproval] = createSignal<PendingApproval>();
  const [submitting, setSubmitting] = createSignal(false);
  let transfer: AbortController | undefined;

  const uploading = () => attachment()?.state.status === "uploading";
  const busy = () => uploading() || submitting();
  const update = (file: File, state: AttachmentState) => {
    const current = attachment();
    if (current?.file === file) setAttachment({ ...current, state });
  };
  const confirm = (host: string) =>
    new Promise<ApprovalAnswer>((resolve) =>
      setPendingApproval({
        host,
        answer: (answer) => {
          setPendingApproval(undefined);
          resolve(answer);
        },
      }),
    );
  const clear = () => {
    transfer?.abort();
    transfer = undefined;
    pendingApproval()?.answer(declined);
    const current = attachment();
    if (current !== undefined) revokeUrl(current.previewUrl);
    setAttachment(undefined);
    setPendingReplacement(undefined);
  };
  const replace = (file: File) => {
    clear();
    setAttachment({
      file,
      previewUrl: createUrl(file),
      state: { status: "ready" },
    });
  };

  const upload = async (file: File): Promise<string | undefined> => {
    const uploads = options.uploads();
    if (uploads === undefined) {
      update(file, failed({ kind: "unavailable" }));
      return undefined;
    }
    const controller = new AbortController();
    transfer = controller;
    update(file, { status: "uploading", progress: 0 });
    let result: UploadResult;
    try {
      result = await uploads.upload(file, {
        confirm,
        onProgress: (progress) =>
          update(file, { status: "uploading", progress }),
        signal: controller.signal,
      });
    } catch {
      result = controller.signal.aborted
        ? { kind: "aborted" }
        : { kind: "network" };
    }
    if (result.kind === "uploaded") {
      update(file, { status: "uploaded", url: result.url });
      return result.url;
    }
    if (result.kind !== "aborted") update(file, failed(result));
    return undefined;
  };

  return {
    attachment,
    pendingReplacement,
    pendingApproval,
    busy,

    /** U8: a paste replaces the image, asking first only while it uploads. */
    attach(file: File) {
      if (uploading()) setPendingReplacement(file);
      else replace(file);
    },
    confirmReplacement() {
      const file = pendingReplacement();
      if (file !== undefined) replace(file);
    },
    cancelReplacement() {
      setPendingReplacement(undefined);
    },
    remove: clear,

    /**
     * Uploads if needed, then submits `caption URL`. The attachment goes only once the message
     * is accepted; an already uploaded URL is reused when the send is retried.
     */
    async send(
      caption: string,
      commands: readonly CommandSpec[],
      submit: (message: string) => Promise<boolean>,
    ): Promise<void> {
      const current = attachment();
      if (current === undefined || busy()) return;
      const known = uploadedUrl(current.state);
      if (!captionTakesImage(caption, commands)) {
        update(current.file, failed({ kind: "command" }, known));
        return;
      }
      setSubmitting(true);
      try {
        const url = known ?? (await upload(current.file));
        if (url === undefined || attachment()?.file !== current.file) return;
        const accepted = await submit(messageWithImage(caption, url));
        if (attachment()?.file !== current.file) return;
        if (accepted) clear();
        else update(current.file, failed({ kind: "send_rejected" }, url));
      } finally {
        setSubmitting(false);
      }
    },
  };
}

function uploadedUrl(state: AttachmentState): string | undefined {
  if (state.status === "uploaded") return state.url;
  return state.status === "failed" ? state.url : undefined;
}

function failed(
  failure: AttachmentFailure | UploadFailure,
  url?: string,
): AttachmentState {
  return url === undefined
    ? { status: "failed", failure }
    : { status: "failed", failure, url };
}
