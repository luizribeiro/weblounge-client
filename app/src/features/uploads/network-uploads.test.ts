import { describe, expect, it } from "vitest";
import type { EngineClient } from "../../engine/EngineClient";
import type {
  EngineClientMessage,
  EngineRequestEnvelope,
  NetworkProjection,
} from "../../engine/protocol";
import type { Uploader, UploadRequest } from "../../platform/upload/uploader";
import { networkUploads } from "./network-uploads";

const url = "https://files.example.org/AbCdEfGhIjKlMnOpQrStUv.png";

class ResolvingEngine {
  readonly requests: EngineRequestEnvelope[] = [];
  readonly #listeners = new Set<(message: EngineClientMessage) => void>();
  send(request: EngineRequestEnvelope) {
    this.requests.push(request);
    queueMicrotask(() => {
      for (const listener of this.#listeners)
        listener({
          type: "upload_resolved",
          command_id: request.id,
          resolution: {
            kind: "ready",
            endpoint: "https://files.example.org/upload",
            authorization: { kind: "host_bearer" },
          },
        });
    });
    return Promise.resolve({ type: "command_result" as const, id: request.id });
  }
  subscribe(listener: (message: EngineClientMessage) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

const network = (filehost_origin?: string): NetworkProjection => ({
  id: 4,
  label: "Example",
  nickname: "luiz",
  state: { status: "online" } as unknown as NetworkProjection["state"],
  ...(filehost_origin === undefined ? {} : { filehost_origin }),
});

describe("networkUploads", () => {
  it("is absent for a network without a file host", () => {
    expect(
      networkUploads(network(), {
        engine: new ResolvingEngine() as unknown as EngineClient,
        uploader: { upload: async () => ({ kind: "network" }) },
        codec: { reencode: async () => undefined },
      }),
    ).toBeUndefined();
  });

  it("resolves through the engine for its network and uploads with a fresh bearer", async () => {
    const engine = new ResolvingEngine();
    const requests: UploadRequest[] = [];
    const uploader: Uploader = {
      upload: async (request) => {
        requests.push(request);
        return { kind: "uploaded", url };
      },
    };
    const uploads = networkUploads(network("https://files.example.org"), {
      engine: engine as unknown as EngineClient,
      uploader,
      codec: { reencode: async () => undefined },
      bearer: async () => "token-1",
    });
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    await expect(
      uploads?.upload(new File([png], "image.png"), {
        confirm: () => Promise.reject(new Error("unexpected")),
      }),
    ).resolves.toEqual({ kind: "uploaded", url });
    expect(engine.requests[0]?.request).toEqual({
      type: "resolve_upload",
      network_id: 4,
      approval: null,
    });
    expect(requests[0]?.authorization).toBe("Bearer token-1");
  });
});
