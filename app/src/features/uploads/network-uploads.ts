import type { EngineClient } from "../../engine/EngineClient";
import type { UploadApproval } from "../../engine/generated/UploadApproval";
import type { UploadResolution } from "../../engine/generated/UploadResolution";
import type { NetworkProjection } from "../../engine/protocol";
import { requestReply } from "../../engine/request-reply";
import type { Uploader } from "../../platform/upload/uploader";
import type { ImageCodec } from "./image-codec";
import type { NetworkUploads } from "./types";
import { uploadImage } from "./upload-image";

export interface UploadServices {
  readonly engine: EngineClient;
  readonly uploader: Uploader;
  readonly codec: ImageCodec;
  /** The deployment's fresh bearer token, for hosted logins. */
  readonly bearer?: (() => Promise<string>) | undefined;
}

/** Uploads for one network, or undefined when it advertises no file host. */
export function networkUploads(
  network: NetworkProjection,
  services: UploadServices,
): NetworkUploads | undefined {
  if (network.filehost_origin === undefined) return undefined;
  const { bearer, codec, engine, uploader } = services;
  return {
    upload: (file, options) =>
      uploadImage(
        file,
        {
          resolve: (approval, signal) =>
            resolveUpload(engine, network.id, approval, signal),
          uploader,
          codec,
          bearer,
        },
        options,
      ),
  };
}

export function resolveUpload(
  engine: EngineClient,
  networkId: number,
  approval: UploadApproval | undefined,
  signal?: AbortSignal,
): Promise<UploadResolution> {
  return requestReply(
    engine,
    {
      type: "resolve_upload",
      network_id: networkId,
      approval: approval ?? null,
    },
    (message, commandId) =>
      message.type === "upload_resolved" && message.command_id === commandId
        ? { value: message.resolution }
        : undefined,
    signal,
  );
}
