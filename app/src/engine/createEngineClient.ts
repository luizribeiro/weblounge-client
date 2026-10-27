import {
  type EngineConnection,
  type EnginePort,
  WorkerEngineClient,
} from "./EngineClient";

interface SharedWorkerHandle {
  port: EnginePort & { close(): void };
}

interface DedicatedWorkerHandle extends EnginePort {
  terminate(): void;
}

export interface WorkerConstructors {
  openShared?: (url: URL) => SharedWorkerHandle;
  openDedicated: (url: URL) => DedicatedWorkerHandle;
}

export function createEngineClient(
  constructors: WorkerConstructors = browserWorkerConstructors(),
): WorkerEngineClient {
  const sharedUrl = new URL("./engine.shared-worker.ts", import.meta.url);
  if (constructors.openShared !== undefined) {
    const worker = constructors.openShared(sharedUrl);
    return new WorkerEngineClient(sharedConnection(worker));
  }

  const worker = constructors.openDedicated(
    new URL("./engine.dedicated-worker.ts", import.meta.url),
  );
  return new WorkerEngineClient(dedicatedConnection(worker));
}

function browserWorkerConstructors(): WorkerConstructors {
  const dedicated: WorkerConstructors = {
    openDedicated: (url) =>
      new Worker(url, {
        name: "weblounge-engine",
        type: "module",
      }) as unknown as DedicatedWorkerHandle,
  };
  if (typeof SharedWorker === "undefined") return dedicated;

  return {
    ...dedicated,
    openShared: (url) =>
      new SharedWorker(url, {
        name: "weblounge-engine",
        type: "module",
      }) as unknown as SharedWorkerHandle,
  };
}

function sharedConnection(worker: SharedWorkerHandle): EngineConnection {
  return {
    port: worker.port,
    close: () => worker.port.close(),
  };
}

function dedicatedConnection(worker: DedicatedWorkerHandle): EngineConnection {
  return {
    port: worker,
    close: () => worker.terminate(),
  };
}
