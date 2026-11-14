import { describe, expect, it } from "vitest";
import { inlineDisposition, XhrUploader } from "./uploader";

class FakeXhr {
  readonly headers = new Map<string, string>();
  readonly responseHeaders = new Map<string, string>();
  method = "";
  url = "";
  body: Blob | undefined;
  aborted = false;
  status = 0;
  responseText = "";
  responseURL = "";
  withCredentials = true;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }
  getResponseHeader(name: string) {
    return this.responseHeaders.get(name) ?? null;
  }
  send(body: Blob) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.({
      lengthComputable,
      loaded,
      total,
    } as ProgressEvent);
  }
  respond(status: number, headers: Record<string, string>, body = "") {
    this.status = status;
    this.responseURL = this.url;
    this.responseText = body;
    for (const [name, value] of Object.entries(headers))
      this.responseHeaders.set(name, value);
    this.onload?.();
  }
}

const endpoint = "https://files.weblounge.org/upload";
const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
  type: "image/png",
});

function uploader() {
  const xhr = new FakeXhr();
  return {
    xhr,
    uploader: new XhrUploader(() => xhr as unknown as XMLHttpRequest),
  };
}

describe("XhrUploader", () => {
  it("posts the body with authorization and an inline filename, without cookies", async () => {
    const { xhr, uploader: subject } = uploader();
    const result = subject.upload({
      endpoint,
      authorization: "Basic d2VibG91bmdlOng=",
      body: png,
      filename: "Screenshot 2026-11-13.png",
    });
    xhr.respond(201, {
      Location: "https://files.weblounge.org/AbCdEfGhIjKlMnOpQrStUv.png",
    });

    await expect(result).resolves.toEqual({
      kind: "uploaded",
      url: "https://files.weblounge.org/AbCdEfGhIjKlMnOpQrStUv.png",
    });
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe(endpoint);
    expect(xhr.body).toBe(png);
    expect(xhr.withCredentials).toBe(false);
    expect(Object.fromEntries(xhr.headers)).toEqual({
      Authorization: "Basic d2VibG91bmdlOng=",
      "Content-Type": "image/png",
      "Content-Disposition":
        "inline; filename*=UTF-8''Screenshot%202026-11-13.png",
    });
  });

  it("reports determinate progress only", async () => {
    const { xhr, uploader: subject } = uploader();
    const progress: number[] = [];
    const result = subject.upload({
      endpoint,
      authorization: "Bearer t",
      body: png,
      filename: "a.png",
      onProgress: (fraction) => progress.push(fraction),
    });
    xhr.progress(5, 0, false);
    xhr.progress(25, 100);
    xhr.progress(100, 100);
    xhr.respond(413, { "Upload-Limit": "maxsize=10000000" });

    await expect(result).resolves.toEqual({
      kind: "too_large",
      limit: 10_000_000,
    });
    expect(progress).toEqual([0.25, 1]);
  });

  it("aborts through the signal, before or during the transfer", async () => {
    const before = new AbortController();
    before.abort();
    const idle = uploader();
    await expect(
      idle.uploader.upload({
        endpoint,
        authorization: "Bearer t",
        body: png,
        filename: "a.png",
        signal: before.signal,
      }),
    ).resolves.toEqual({ kind: "aborted" });
    expect(idle.xhr.method).toBe("");

    const during = new AbortController();
    const { xhr, uploader: subject } = uploader();
    const result = subject.upload({
      endpoint,
      authorization: "Bearer t",
      body: png,
      filename: "a.png",
      signal: during.signal,
    });
    during.abort();
    await expect(result).resolves.toEqual({ kind: "aborted" });
    expect(xhr.aborted).toBe(true);
  });

  it("reports network errors and timeouts", async () => {
    for (const fail of ["onerror", "ontimeout"] as const) {
      const { xhr, uploader: subject } = uploader();
      const result = subject.upload({
        endpoint,
        authorization: "Bearer t",
        body: new Blob(["x"]),
        filename: "a.png",
      });
      expect(xhr.headers.get("Content-Type")).toBe("application/octet-stream");
      xhr[fail]?.();
      await expect(result).resolves.toEqual({ kind: "network" });
    }
  });
});

describe("inlineDisposition", () => {
  it("percent-encodes RFC 5987 reserved characters", () => {
    expect(inlineDisposition("ünïcode (1)'s*.jpg")).toBe(
      "inline; filename*=UTF-8''%C3%BCn%C3%AFcode%20%281%29%27s%2A.jpg",
    );
  });
});
