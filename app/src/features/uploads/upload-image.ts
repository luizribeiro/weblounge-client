import type { UploadApproval } from "../../engine/generated/UploadApproval";
import type { UploadAuthorization } from "../../engine/generated/UploadAuthorization";
import type { UploadResolution } from "../../engine/generated/UploadResolution";
import type { Uploader, UploadOutcome } from "../../platform/upload/uploader";
import type { ImageCodec } from "./image-codec";
import { type PreparedImage, prepareImage, shrinkImage } from "./prepare-image";
import type { UploadFailure, UploadOptions, UploadResult } from "./types";

/** One network's way to an upload target; bound by the app, independent of the composer. */
export interface UploadTargets {
  resolve(
    approval: UploadApproval | undefined,
    signal: AbortSignal | undefined,
  ): Promise<UploadResolution>;
  readonly bearer?: (() => Promise<string>) | undefined;
  readonly uploader: Uploader;
  readonly codec: ImageCodec;
}

type Target =
  | {
      readonly kind: "ready";
      readonly endpoint: string;
      readonly authorization: string;
    }
  | UploadFailure;

const aborted = { kind: "aborted" } as const;

// A call, not a property read, so TypeScript does not narrow it across awaits.
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function uploadImage(
  file: File,
  targets: UploadTargets,
  options: UploadOptions,
): Promise<UploadResult> {
  const image = await prepareImage(file, targets.codec);
  if (isAborted(options.signal)) return aborted;
  if (image === undefined) return { kind: "undecodable" };
  const target = await authorizedTarget(targets, options);
  if (target.kind !== "ready") return target;
  const outcome = await send(image, target, options, targets);
  if (outcome.kind !== "too_large" || outcome.limit === undefined)
    return outcome;
  const smaller = await shrinkImage(image, outcome.limit, targets.codec);
  return smaller === undefined
    ? outcome
    : send(smaller, target, options, targets);
}

// Every step after an await checks the signal, so an image removed meanwhile never asks for
// approval or stores one.
async function authorizedTarget(
  targets: UploadTargets,
  options: UploadOptions,
): Promise<Target> {
  let resolution = await targets.resolve(undefined, options.signal);
  if (isAborted(options.signal)) return aborted;
  if (resolution.kind === "approval_required") {
    const answer = await options.confirm(resolution.host);
    if (isAborted(options.signal)) return aborted;
    if (!answer.allow) return { kind: "declined" };
    resolution = await targets.resolve(
      { host: resolution.host, remember: answer.remember },
      options.signal,
    );
    if (isAborted(options.signal)) return aborted;
  }
  switch (resolution.kind) {
    case "unavailable":
    case "offline":
      return { kind: resolution.kind };
    case "approval_required":
      return { kind: "declined" };
    case "ready": {
      const authorization = await header(resolution.authorization, targets);
      if (isAborted(options.signal)) return aborted;
      return authorization === undefined
        ? { kind: "unauthorized" }
        : { kind: "ready", endpoint: resolution.endpoint, authorization };
    }
  }
}

async function header(
  authorization: UploadAuthorization,
  targets: UploadTargets,
): Promise<string | undefined> {
  switch (authorization.kind) {
    case "basic":
      return authorization.header;
    case "host_bearer":
      try {
        const token = await targets.bearer?.();
        return token === undefined ? undefined : `Bearer ${token}`;
      } catch {
        return undefined;
      }
  }
}

function send(
  image: PreparedImage,
  target: Extract<Target, { kind: "ready" }>,
  options: UploadOptions,
  targets: UploadTargets,
): Promise<UploadOutcome> {
  return targets.uploader.upload({
    endpoint: target.endpoint,
    authorization: target.authorization,
    body: image.body,
    filename: image.filename,
    onProgress: options.onProgress,
    signal: options.signal,
  });
}
