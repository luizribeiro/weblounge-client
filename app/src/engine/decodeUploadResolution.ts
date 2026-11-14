import { isRecord } from "./decode-primitives";
import type { UploadAuthorization } from "./generated/UploadAuthorization";
import type { UploadResolution } from "./generated/UploadResolution";

export function decodeUploadResolution(
  value: unknown,
): UploadResolution | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.kind) {
    case "unavailable":
    case "offline":
      return { kind: value.kind };
    case "approval_required":
      return typeof value.host === "string"
        ? { kind: value.kind, host: value.host }
        : undefined;
    case "ready": {
      const authorization = decodeAuthorization(value.authorization);
      return typeof value.endpoint === "string" && authorization !== undefined
        ? { kind: value.kind, endpoint: value.endpoint, authorization }
        : undefined;
    }
    default:
      return undefined;
  }
}

function decodeAuthorization(value: unknown): UploadAuthorization | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "host_bearer") return { kind: value.kind };
  if (value.kind === "basic" && typeof value.header === "string")
    return { kind: value.kind, header: value.header };
  return undefined;
}
