import { describe, expect, it } from "vitest";
import { decodeUploadResolution } from "./decodeUploadResolution";

describe("decodeUploadResolution", () => {
  it("accepts every resolution the engine sends", () => {
    for (const resolution of [
      { kind: "unavailable" },
      { kind: "offline" },
      { kind: "other_site" },
      { kind: "approval_required", host: "files.elsewhere.test:8443" },
      {
        kind: "ready",
        endpoint: "https://files.weblounge.org/upload",
        authorization: { kind: "basic", header: "Basic bHVpejpodW50ZXIy" },
      },
      {
        kind: "ready",
        endpoint: "https://files.weblounge.org/upload",
        authorization: { kind: "host_bearer" },
      },
    ]) {
      expect(decodeUploadResolution(resolution)).toEqual(resolution);
    }
  });

  it("rejects malformed resolutions", () => {
    for (const value of [
      null,
      "ready",
      { kind: "uploaded" },
      { kind: "approval_required" },
      { kind: "ready", endpoint: "https://files.weblounge.org/upload" },
      {
        kind: "ready",
        endpoint: "https://files.weblounge.org/upload",
        authorization: { kind: "basic" },
      },
      {
        kind: "ready",
        endpoint: 7,
        authorization: { kind: "host_bearer" },
      },
    ]) {
      expect(decodeUploadResolution(value)).toBeUndefined();
    }
  });
});
