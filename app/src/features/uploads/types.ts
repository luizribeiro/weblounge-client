import type { UploadOutcome } from "../../platform/upload/uploader";

export type UploadFailure =
  | { readonly kind: "offline" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "other_site" }
  | { readonly kind: "declined" }
  | { readonly kind: "undecodable" }
  | Exclude<UploadOutcome, { readonly kind: "uploaded" }>;

export type UploadResult =
  | { readonly kind: "uploaded"; readonly url: string }
  | UploadFailure;

export interface ApprovalAnswer {
  readonly allow: boolean;
  readonly remember: boolean;
}

export interface UploadOptions {
  readonly confirm: (host: string) => Promise<ApprovalAnswer>;
  readonly onProgress?: ((fraction: number) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** A network's upload entry point, absent when the network advertises no file host. */
export interface NetworkUploads {
  upload(file: File, options: UploadOptions): Promise<UploadResult>;
}
