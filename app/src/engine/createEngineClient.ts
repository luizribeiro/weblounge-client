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
  constructors?: WorkerConstructors,
): WorkerEngineClient {
  if (constructors === undefined) return createBrowserEngineClient();

  const sharedUrl = new URL("./engine.shared-worker.ts", import.meta.url);
  if (constructors.openShared !== undefined) {
    const worker = constructors.openShared(sharedUrl);
    return new WorkerEngineClient(sharedConnection(worker));
  }

  const worker = constructors.openDedicated(
    new URL("./engine.dedicated-worker.ts", import.meta.url),
  );
  return dedicatedEngineClient(worker);
}

function createBrowserEngineClient(): WorkerEngineClient {
  if (typeof SharedWorker !== "undefined") {
    const worker = new SharedWorker(
      new URL("./engine.shared-worker.ts", import.meta.url),
      { name: "weblounge-engine", type: "module" },
    );
    return new WorkerEngineClient(sharedConnection(worker));
  }

  const worker = new Worker(
    new URL("./engine.dedicated-worker.ts", import.meta.url),
    { name: "weblounge-engine", type: "module" },
  );
  return dedicatedEngineClient(worker);
}

function dedicatedEngineClient(
  worker: DedicatedWorkerHandle,
): WorkerEngineClient {
  return new WorkerEngineClient(dedicatedConnection(worker), undefined, [
    {
      type: "notice",
      message_key: "engine.dedicated_worker_fallback",
    },
  ]);
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
