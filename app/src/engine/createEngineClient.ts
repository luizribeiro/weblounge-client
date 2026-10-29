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
    const openShared = constructors.openShared;
    const open = () => sharedConnection(openShared(sharedUrl));
    return new WorkerEngineClient(open(), undefined, [], open);
  }

  const dedicatedUrl = new URL("./engine.dedicated-worker.ts", import.meta.url);
  const open = () =>
    dedicatedConnection(constructors.openDedicated(dedicatedUrl));
  return dedicatedEngineClient(open(), open);
}

function createBrowserEngineClient(): WorkerEngineClient {
  if (typeof SharedWorker !== "undefined") {
    const sharedUrl = new URL("./engine.shared-worker.ts", import.meta.url);
    const open = () =>
      sharedConnection(
        new SharedWorker(sharedUrl, {
          name: "weblounge-engine",
          type: "module",
        }),
      );
    return new WorkerEngineClient(open(), undefined, [], open);
  }

  const dedicatedUrl = new URL("./engine.dedicated-worker.ts", import.meta.url);
  const open = () =>
    dedicatedConnection(
      new Worker(dedicatedUrl, {
        name: "weblounge-engine",
        type: "module",
      }),
    );
  return dedicatedEngineClient(open(), open);
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
        message_key: "engine.dedicated_worker_fallback",
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
