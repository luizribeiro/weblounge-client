import { describe, expect, it, vi } from "vitest";
import type { UploadApproval } from "../../engine/generated/UploadApproval";
import type { UploadResolution } from "../../engine/generated/UploadResolution";
import type {
  Uploader,
  UploadOutcome,
  UploadRequest,
} from "../../platform/upload/uploader";
import type { ImageCodec } from "./image-codec";
import { type UploadTargets, uploadImage } from "./upload-image";

const endpoint = "https://files.example.org/upload";
const uploaded: UploadOutcome = {
  kind: "uploaded",
  url: "https://files.example.org/AbCdEfGhIjKlMnOpQrStUv.png",
};
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
const screenshot = new File([png, new Uint8Array(991)], "image.png", {
  type: "image/png",
});

class FakeUploader implements Uploader {
  readonly requests: UploadRequest[] = [];
  constructor(private readonly outcomes: UploadOutcome[]) {}
  async upload(request: UploadRequest) {
    this.requests.push(request);
    return this.outcomes.shift() ?? { kind: "network" };
  }
}

const shrinkingCodec: ImageCodec = {
  reencode: async () => new Blob([png]),
};

function targets(
  resolutions: UploadResolution[],
  outcomes: UploadOutcome[] = [uploaded],
  bearer?: () => Promise<string>,
) {
  const approvals: (UploadApproval | undefined)[] = [];
  const uploader = new FakeUploader(outcomes);
  const subject: UploadTargets = {
    resolve: async (approval) => {
      approvals.push(approval);
      return resolutions.shift() ?? { kind: "unavailable" };
    },
    uploader,
    codec: shrinkingCodec,
    ...(bearer === undefined ? {} : { bearer }),
  };
  return { subject, approvals, uploader };
}

const basic: UploadResolution = {
  kind: "ready",
  endpoint,
  authorization: { kind: "basic", header: "Basic bHVpejpodW50ZXIy" },
};
const neverAsked = () => Promise.reject(new Error("must not ask"));

describe("uploadImage", () => {
  it("uploads with the engine's Basic header and reports progress", async () => {
    const { subject, uploader } = targets([basic]);
    const onProgress = vi.fn();
    const signal = new AbortController().signal;
    await expect(
      uploadImage(screenshot, subject, {
        confirm: neverAsked,
        onProgress,
        signal,
      }),
    ).resolves.toEqual(uploaded);
    expect(uploader.requests).toEqual([
      expect.objectContaining({
        endpoint,
        authorization: "Basic bHVpejpodW50ZXIy",
        filename: "image.png",
        onProgress,
        signal,
      }),
    ]);
  });

  it("asks before a foreign host and resolves again with the answer", async () => {
    const { subject, approvals } = targets([
      { kind: "approval_required", host: "files.elsewhere.test" },
      basic,
    ]);
    const confirm = vi.fn(async () => ({ allow: true, remember: true }));
    await expect(
      uploadImage(screenshot, subject, { confirm }),
    ).resolves.toEqual(uploaded);
    expect(confirm).toHaveBeenCalledWith("files.elsewhere.test");
    expect(approvals).toEqual([
      undefined,
      { host: "files.elsewhere.test", remember: true },
    ]);
  });

  it("stops when the user declines or the host changes meanwhile", async () => {
    const declined = targets([{ kind: "approval_required", host: "a.test" }]);
    await expect(
      uploadImage(screenshot, declined.subject, {
        confirm: async () => ({ allow: false, remember: true }),
      }),
    ).resolves.toEqual({ kind: "declined" });
    expect(declined.uploader.requests).toEqual([]);

    const moved = targets([
      { kind: "approval_required", host: "a.test" },
      { kind: "approval_required", host: "b.test" },
    ]);
    await expect(
      uploadImage(screenshot, moved.subject, {
        confirm: async () => ({ allow: true, remember: false }),
      }),
    ).resolves.toEqual({ kind: "declined" });
    expect(moved.uploader.requests).toEqual([]);
  });

  it("stops at once when aborted while waiting for approval", async () => {
    const { subject, approvals, uploader } = targets([
      { kind: "approval_required", host: "a.test" },
      basic,
    ]);
    const controller = new AbortController();
    await expect(
      uploadImage(screenshot, subject, {
        confirm: async () => {
          controller.abort();
          return { allow: true, remember: true };
        },
        signal: controller.signal,
      }),
    ).resolves.toEqual({ kind: "aborted" });
    expect(approvals).toEqual([undefined]);
    expect(uploader.requests).toEqual([]);
  });

  it("refuses offline and on networks without a file host", async () => {
    for (const kind of ["offline", "unavailable"] as const) {
      const { subject, uploader } = targets([{ kind }]);
      await expect(
        uploadImage(screenshot, subject, { confirm: neverAsked }),
      ).resolves.toEqual({ kind });
      expect(uploader.requests).toEqual([]);
    }
  });

  it("asks the deployment for a fresh bearer token", async () => {
    const hosted: UploadResolution = {
      kind: "ready",
      endpoint,
      authorization: { kind: "host_bearer" },
    };
    const fresh = targets([hosted], [uploaded], async () => "token-7391");
    await uploadImage(screenshot, fresh.subject, { confirm: neverAsked });
    expect(fresh.uploader.requests[0]?.authorization).toBe("Bearer token-7391");

    for (const bearer of [
      undefined,
      () => Promise.reject(new Error("sign-in needed")),
    ]) {
      const failing = targets([hosted], [uploaded], bearer);
      await expect(
        uploadImage(screenshot, failing.subject, { confirm: neverAsked }),
      ).resolves.toEqual({ kind: "unauthorized" });
      expect(failing.uploader.requests).toEqual([]);
    }
  });

  it("shrinks once after a 413 with a limit", async () => {
    const { subject, uploader } = targets(
      [basic],
      [{ kind: "too_large", limit: 500 }, uploaded],
    );
    await expect(
      uploadImage(screenshot, subject, { confirm: neverAsked }),
    ).resolves.toEqual(uploaded);
    expect(uploader.requests.map((request) => request.body.size)).toEqual([
      1000,
      png.length,
    ]);

    const stillLarge = targets(
      [basic],
      [
        { kind: "too_large", limit: 500 },
        { kind: "too_large", limit: 500 },
      ],
    );
    await expect(
      uploadImage(screenshot, stillLarge.subject, { confirm: neverAsked }),
    ).resolves.toEqual({ kind: "too_large", limit: 500 });
    expect(stillLarge.uploader.requests).toHaveLength(2);
  });

  it("does not retry a 413 without a limit or other failures", async () => {
    for (const outcome of [
      { kind: "too_large" },
      { kind: "unauthorized" },
      { kind: "rate_limited" },
    ] as const) {
      const { subject, uploader } = targets([basic], [outcome, uploaded]);
      await expect(
        uploadImage(screenshot, subject, { confirm: neverAsked }),
      ).resolves.toEqual(outcome);
      expect(uploader.requests).toHaveLength(1);
    }
  });

  it("fails without resolving when the image cannot be read", async () => {
    const { subject, approvals } = targets([basic]);
    const heic = new File([new Uint8Array([0, 0, 0, 0x18])], "IMG.HEIC");
    await expect(
      uploadImage(
        heic,
        { ...subject, codec: { reencode: async () => undefined } },
        { confirm: neverAsked },
      ),
    ).resolves.toEqual({ kind: "undecodable" });
    expect(approvals).toEqual([]);
  });
});
