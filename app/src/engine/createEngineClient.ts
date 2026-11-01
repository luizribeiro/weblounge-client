import {
  type EngineConnection,
  type EnginePort,
  WorkerEngineClient,
} from "./EngineClient";
import dedicatedWorkerUrl from "./engine.dedicated-worker.ts?worker&url";
import sharedWorkerUrl from "./engine.shared-worker.ts?worker&url";

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

  const sharedUrl = workerUrl(sharedWorkerUrl);
  if (constructors.openShared !== undefined) {
    const openShared = constructors.openShared;
    const open = () => sharedConnection(openShared(sharedUrl));
    return new WorkerEngineClient(open(), undefined, [], open);
  }

  const dedicatedUrl = workerUrl(dedicatedWorkerUrl);
  const open = () =>
    dedicatedConnection(constructors.openDedicated(dedicatedUrl));
  return dedicatedEngineClient(open(), open);
}

function createBrowserEngineClient(): WorkerEngineClient {
  if (typeof SharedWorker !== "undefined") {
    const open = () =>
      sharedConnection(
        new SharedWorker(workerUrl(sharedWorkerUrl), {
          name: "weblounge-engine",
          type: "module",
        }),
      );
    return new WorkerEngineClient(open(), undefined, [], open);
  }

  const open = () =>
    dedicatedConnection(
      new Worker(workerUrl(dedicatedWorkerUrl), {
        name: "weblounge-engine",
        type: "module",
      }),
    );
  return dedicatedEngineClient(open(), open);
}

function workerUrl(path: string): URL {
  return new URL(path, import.meta.url);
}

function dedicatedEngineClient(
  connection: EngineConnection,
  recoverConnection: () => EngineConnection,
): WorkerEngineClient {
  return new WorkerEngineClient(
    connection,
    undefined,
    [
      {
        type: "notice",
        key: "engine.dedicated_worker_fallback",
        values: {},
        tone: "neutral",
        action: null,
      },
    ],
    recoverConnection,
  );
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
