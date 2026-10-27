import { expect, it, vi } from "vitest";
import {
  createEngineClient,
  type WorkerConstructors,
} from "./createEngineClient";
import type { EnginePort } from "./EngineClient";

function fakePort(): EnginePort {
  return {
    postMessage: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    start: vi.fn(),
  };
}

it("prefers a SharedWorker when available", async () => {
  const port = { ...fakePort(), close: vi.fn() };
  const openShared = vi.fn(() => ({ port }));
  const openDedicated = vi.fn();
  const constructors: WorkerConstructors = { openShared, openDedicated };

  const client = createEngineClient(constructors);
  await client.close();

  expect(openShared).toHaveBeenCalledOnce();
  expect(openDedicated).not.toHaveBeenCalled();
  expect(port.close).toHaveBeenCalledOnce();
});

it("uses and owns a dedicated Worker when SharedWorker is unavailable", async () => {
  const worker = { ...fakePort(), terminate: vi.fn() };
  const openDedicated = vi.fn(() => worker);

  const client = createEngineClient({ openDedicated });
  await client.close();

  expect(openDedicated).toHaveBeenCalledOnce();
  expect(worker.terminate).toHaveBeenCalledOnce();
});
