export type UploadOutcome =
  | { readonly kind: "uploaded"; readonly url: string }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "too_large"; readonly limit?: number }
  | { readonly kind: "unsupported_type" }
  | { readonly kind: "rate_limited" }
  | { readonly kind: "quota_full" }
  | {
      readonly kind: "failed";
      readonly status: number;
      readonly detail?: string;
    }
  | { readonly kind: "network" }
  | { readonly kind: "aborted" };

export interface UploadResponse {
  readonly status: number;
  readonly location: string | null;
  readonly uploadLimit: string | null;
  readonly contentType: string | null;
  readonly body: string;
  readonly finalUrl: string;
}

const detailLength = 200;

export function uploadOutcome(
  response: UploadResponse,
  endpoint: string,
): UploadOutcome {
  switch (response.status) {
    case 0:
      return { kind: "network" };
    case 201:
      return createdOutcome(response, endpoint);
    case 401:
    case 403:
      return { kind: "unauthorized" };
    case 413: {
      const limit = uploadLimit(response.uploadLimit);
      return limit === undefined
        ? { kind: "too_large" }
        : { kind: "too_large", limit };
    }
    case 415:
      return { kind: "unsupported_type" };
    case 429:
      return { kind: "rate_limited" };
    case 507:
      return { kind: "quota_full" };
    default:
      return failed(response);
  }
}

// A redirect may have moved the request elsewhere; only a 201 from the endpoint's own origin
// is trusted, and only an https: link is ever sent.
function createdOutcome(
  response: UploadResponse,
  endpoint: string,
): UploadOutcome {
  const origin = new URL(endpoint).origin;
  if (response.finalUrl !== "" && originOf(response.finalUrl) !== origin)
    return failed(response);
  if (response.location === null) return failed(response);
  try {
    const url = new URL(response.location, endpoint);
    return url.protocol === "https:"
      ? { kind: "uploaded", url: url.href }
      : failed(response);
  } catch {
    return failed(response);
  }
}

function failed(response: UploadResponse): UploadOutcome {
  const detail = plainTextDetail(response);
  return detail === undefined
    ? { kind: "failed", status: response.status }
    : { kind: "failed", status: response.status, detail };
}

function plainTextDetail(response: UploadResponse): string | undefined {
  if (!response.contentType?.toLowerCase().startsWith("text/plain"))
    return undefined;
  const detail = response.body.trim().slice(0, detailLength);
  return detail === "" ? undefined : detail;
}

export function uploadLimit(header: string | null): number | undefined {
  const match =
    header === null ? null : /(?:^|[\s,;])maxsize=(\d+)/u.exec(header);
  if (match?.[1] === undefined) return undefined;
  const limit = Number(match[1]);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
