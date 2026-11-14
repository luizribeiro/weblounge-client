import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { CommandSpec } from "../../engine/protocol";
import type {
  NetworkUploads,
  UploadOptions,
  UploadResult,
} from "../uploads/types";
import { createAttachmentController } from "./attachment-controller";

const url = "https://files.weblounge.org/AbCdEfGhIjKlMnOpQrStUv.png";
const commands = [
  { name: "me", aliases: [] },
  { name: "join", aliases: [] },
] as unknown as CommandSpec[];
const screenshot = () =>
  new File([new Uint8Array([0x89, 0x50])], "image.png", { type: "image/png" });

class ControlledUploads implements NetworkUploads {
  readonly calls: { file: File; options: UploadOptions }[] = [];
  #finish: ((result: UploadResult) => void) | undefined;
  upload(file: File, options: UploadOptions) {
    this.calls.push({ file, options });
    return new Promise<UploadResult>((resolve) => {
      this.#finish = resolve;
      options.signal?.addEventListener("abort", () =>
        resolve({ kind: "aborted" }),
      );
    });
  }
  finish(result: UploadResult) {
    this.#finish?.(result);
  }
}

function setup(uploads: NetworkUploads | undefined) {
  const revoked: string[] = [];
  let created = 0;
  const controller = createRoot(() =>
    createAttachmentController({
      uploads: () => uploads,
      createUrl: () => {
        created += 1;
        return `blob:preview-${created}`;
      },
      revokeUrl: (preview) => revoked.push(preview),
    }),
  );
  return { controller, revoked };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("createAttachmentController", () => {
  it("uploads on send with progress, then submits caption and URL once", async () => {
    const uploads = new ControlledUploads();
    const { controller, revoked } = setup(uploads);
    const file = screenshot();
    controller.attach(file);
    expect(controller.attachment()?.state).toEqual({ status: "ready" });
    expect(uploads.calls).toEqual([]);

    const submit = vi.fn(async () => true);
    const sent = controller.send("look", commands, submit);
    await flush();
    expect(controller.busy()).toBe(true);
    uploads.calls[0]?.options.onProgress?.(0.4);
    expect(controller.attachment()?.state).toEqual({
      status: "uploading",
      progress: 0.4,
    });
    await controller.send("again", commands, submit);
    expect(uploads.calls).toHaveLength(1);

    uploads.finish({ kind: "uploaded", url });
    await sent;
    expect(submit).toHaveBeenCalledExactlyOnceWith(`look ${url}`);
    expect(controller.attachment()).toBeUndefined();
    expect(revoked).toEqual(["blob:preview-1"]);
  });

  it("keeps a failure on the chip, and Retry uploads again", async () => {
    const uploads = new ControlledUploads();
    const { controller } = setup(uploads);
    controller.attach(screenshot());
    const submit = vi.fn(async () => true);
    const first = controller.send("", commands, submit);
    await flush();
    uploads.finish({ kind: "too_large", limit: 10_000_000 });
    await first;
    expect(controller.attachment()?.state).toEqual({
      status: "failed",
      failure: { kind: "too_large", limit: 10_000_000 },
    });
    expect(submit).not.toHaveBeenCalled();

    const retry = controller.send("", commands, submit);
    await flush();
    uploads.finish({ kind: "uploaded", url });
    await retry;
    expect(uploads.calls).toHaveLength(2);
    expect(submit).toHaveBeenCalledWith(url);
  });

  it("reuses the uploaded URL when the send is rejected", async () => {
    const uploads = new ControlledUploads();
    const { controller } = setup(uploads);
    controller.attach(screenshot());
    const submit = vi.fn(async () => false);
    const sent = controller.send("caption", commands, submit);
    await flush();
    uploads.finish({ kind: "uploaded", url });
    await sent;
    expect(controller.attachment()?.state).toEqual({
      status: "failed",
      failure: { kind: "send_rejected" },
      url,
    });

    submit.mockResolvedValueOnce(true);
    await controller.send("caption", commands, submit);
    expect(uploads.calls).toHaveLength(1);
    expect(controller.attachment()).toBeUndefined();
  });

  it("refuses a command caption before uploading", async () => {
    const uploads = new ControlledUploads();
    const { controller } = setup(uploads);
    controller.attach(screenshot());
    await controller.send("/join #lounge", commands, async () => true);
    expect(uploads.calls).toEqual([]);
    expect(controller.attachment()?.state).toEqual({
      status: "failed",
      failure: { kind: "command" },
    });
  });

  it("aborts and revokes on remove", async () => {
    const uploads = new ControlledUploads();
    const { controller, revoked } = setup(uploads);
    controller.attach(screenshot());
    const submit = vi.fn(async () => true);
    const sent = controller.send("", commands, submit);
    await flush();
    controller.remove();
    await sent;
    expect(uploads.calls[0]?.options.signal?.aborted).toBe(true);
    expect(controller.attachment()).toBeUndefined();
    expect(revoked).toEqual(["blob:preview-1"]);
    expect(submit).not.toHaveBeenCalled();
  });

  it("replaces a ready image at once but asks while uploading", async () => {
    const uploads = new ControlledUploads();
    const { controller, revoked } = setup(uploads);
    const first = screenshot();
    const second = screenshot();
    const third = screenshot();
    controller.attach(first);
    controller.attach(second);
    expect(controller.attachment()?.file).toBe(second);
    expect(revoked).toEqual(["blob:preview-1"]);

    const sent = controller.send("", commands, async () => true);
    await flush();
    controller.attach(third);
    expect(controller.pendingReplacement()).toBe(third);
    expect(controller.attachment()?.file).toBe(second);
    controller.cancelReplacement();
    expect(controller.pendingReplacement()).toBeUndefined();

    controller.attach(third);
    controller.confirmReplacement();
    await sent;
    expect(uploads.calls[0]?.options.signal?.aborted).toBe(true);
    expect(controller.attachment()).toEqual({
      file: third,
      previewUrl: "blob:preview-3",
      state: { status: "ready" },
    });
  });

  it("submits once when Send is pressed again while the message goes out", async () => {
    const uploads = new ControlledUploads();
    const { controller } = setup(uploads);
    controller.attach(screenshot());
    let accept: (accepted: boolean) => void = () => undefined;
    const submit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        }),
    );
    const sent = controller.send("", commands, submit);
    await flush();
    uploads.finish({ kind: "uploaded", url });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(controller.busy()).toBe(true);
    await controller.send("", commands, submit);
    accept(true);
    await sent;
    expect(submit).toHaveBeenCalledOnce();
    expect(controller.busy()).toBe(false);
  });

  it("declines a pending approval when the image is removed", async () => {
    const uploads = new ControlledUploads();
    const { controller } = setup(uploads);
    controller.attach(screenshot());
    const sent = controller.send("", commands, async () => true);
    await flush();
    const answer = uploads.calls[0]?.options.confirm("files.elsewhere.test");
    expect(controller.pendingApproval()?.host).toBe("files.elsewhere.test");
    controller.remove();
    await expect(answer).resolves.toEqual({ allow: false, remember: false });
    expect(controller.pendingApproval()).toBeUndefined();
    await sent;
  });

  it("keeps the uploaded URL when a command caption is refused", async () => {
    const uploads = new ControlledUploads();
    const { controller } = setup(uploads);
    controller.attach(screenshot());
    const sent = controller.send("", commands, async () => false);
    await flush();
    uploads.finish({ kind: "uploaded", url });
    await sent;
    await controller.send("/join #lounge", commands, async () => true);
    expect(controller.attachment()?.state).toEqual({
      status: "failed",
      failure: { kind: "command" },
      url,
    });
  });

  it("fails as unavailable without a file host", async () => {
    const { controller } = setup(undefined);
    controller.attach(screenshot());
    await controller.send("", commands, async () => true);
    expect(controller.attachment()?.state).toEqual({
      status: "failed",
      failure: { kind: "unavailable" },
    });
  });
});
