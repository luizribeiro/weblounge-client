import { describe, expect, it } from "vitest";
import {
  type UploadResponse,
  uploadLimit,
  uploadOutcome,
} from "./upload-response";

const endpoint = "https://files.weblounge.org/upload";

function response(overrides: Partial<UploadResponse>): UploadResponse {
  return {
    status: 201,
    location: "https://files.weblounge.org/AbCdEfGhIjKlMnOpQrStUv.png",
    uploadLimit: null,
    contentType: "text/plain; charset=utf-8",
    body: "",
    finalUrl: endpoint,
    ...overrides,
  };
}

describe("uploadOutcome", () => {
  it("resolves an absolute or relative Location against the endpoint", () => {
    expect(uploadOutcome(response({}), endpoint)).toEqual({
      kind: "uploaded",
      url: "https://files.weblounge.org/AbCdEfGhIjKlMnOpQrStUv.png",
    });
    expect(
      uploadOutcome(
        response({ location: "/upload/hoh5eFThae4e.jpeg" }),
        endpoint,
      ),
    ).toEqual({
      kind: "uploaded",
      url: "https://files.weblounge.org/upload/hoh5eFThae4e.jpeg",
    });
  });

  it("refuses a 201 without a usable https link or from another origin", () => {
    for (const overrides of [
      { location: null },
      { location: "http://files.weblounge.org/a.png" },
      { location: "javascript:alert(1)" },
      { finalUrl: "https://elsewhere.test/upload" },
    ]) {
      expect(uploadOutcome(response(overrides), endpoint)).toEqual({
        kind: "failed",
        status: 201,
      });
    }
  });

  it("maps each refusal to a typed outcome", () => {
    for (const [status, outcome] of [
      [0, { kind: "network" }],
      [401, { kind: "unauthorized" }],
      [403, { kind: "unauthorized" }],
      [413, { kind: "too_large", limit: 10_000_000 }],
      [415, { kind: "unsupported_type" }],
      [429, { kind: "rate_limited" }],
      [507, { kind: "quota_full" }],
    ] as const) {
      expect(
        uploadOutcome(
          response({ status, uploadLimit: "maxsize=10000000" }),
          endpoint,
        ),
      ).toEqual(outcome);
    }
  });

  it("keeps a short plain-text server detail for other failures", () => {
    expect(
      uploadOutcome(
        response({
          status: 503,
          body: `  ${"The scrubber is down. ".repeat(20)}`,
        }),
        endpoint,
      ),
    ).toEqual({
      kind: "failed",
      status: 503,
      detail: "The scrubber is down. ".repeat(20).trim().slice(0, 200),
    });
    expect(
      uploadOutcome(
        response({
          status: 400,
          contentType: "text/html",
          body: "<h1>no</h1>",
        }),
        endpoint,
      ),
    ).toEqual({ kind: "failed", status: 400 });
  });
});

describe("uploadLimit", () => {
  it("reads maxsize from Upload-Limit", () => {
    expect(uploadLimit("maxsize=10000000")).toBe(10_000_000);
    expect(uploadLimit("maxfiles=1, maxsize=2048")).toBe(2048);
    expect(uploadLimit(null)).toBeUndefined();
    expect(uploadLimit("maxsize=")).toBeUndefined();
    expect(uploadLimit("notmaxsize=5")).toBeUndefined();
    expect(uploadLimit("maxsize=0")).toBeUndefined();
  });
});
