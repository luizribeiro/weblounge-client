import { type UploadOutcome, uploadOutcome } from "./upload-response";

export type { UploadOutcome } from "./upload-response";

export interface UploadRequest {
  readonly endpoint: string;
  readonly authorization: string;
  readonly body: Blob;
  readonly filename: string;
  readonly onProgress?: ((fraction: number) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface Uploader {
  upload(request: UploadRequest): Promise<UploadOutcome>;
}

export class XhrUploader implements Uploader {
  constructor(
    private readonly createRequest: () => XMLHttpRequest = () =>
      new XMLHttpRequest(),
  ) {}

  upload(request: UploadRequest): Promise<UploadOutcome> {
    return new Promise((resolve) => {
      if (request.signal?.aborted === true) {
        resolve({ kind: "aborted" });
        return;
      }
      const xhr = this.createRequest();
      const abort = () => xhr.abort();
      const finish = (outcome: UploadOutcome) => {
        request.signal?.removeEventListener("abort", abort);
        resolve(outcome);
      };
      xhr.open("POST", request.endpoint);
      xhr.withCredentials = false;
      xhr.setRequestHeader("Authorization", request.authorization);
      xhr.setRequestHeader(
        "Content-Type",
        request.body.type === ""
          ? "application/octet-stream"
          : request.body.type,
      );
      xhr.setRequestHeader(
        "Content-Disposition",
        inlineDisposition(request.filename),
      );
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0)
          request.onProgress?.(Math.min(1, event.loaded / event.total));
      };
      xhr.onload = () =>
        finish(
          uploadOutcome(
            {
              status: xhr.status,
              location: xhr.getResponseHeader("Location"),
              uploadLimit: xhr.getResponseHeader("Upload-Limit"),
              contentType: xhr.getResponseHeader("Content-Type"),
              body: xhr.responseText,
              finalUrl: xhr.responseURL,
            },
            request.endpoint,
          ),
        );
      xhr.onerror = () => finish({ kind: "network" });
      xhr.ontimeout = () => finish({ kind: "network" });
      xhr.onabort = () => finish({ kind: "aborted" });
      request.signal?.addEventListener("abort", abort, { once: true });
      xhr.send(request.body);
    });
  }
}

export function inlineDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename*=UTF-8''${encoded}`;
}
