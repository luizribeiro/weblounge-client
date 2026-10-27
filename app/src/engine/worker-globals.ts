import type { WorkerHostPort } from "./worker-runtime";

interface SharedWorkerConnectEvent extends Event {
  readonly ports: readonly MessagePort[];
}

interface SharedWorkerScope {
  onconnect: ((event: SharedWorkerConnectEvent) => void) | null;
}

export function workerHostPort(value: unknown): WorkerHostPort {
  assertWorkerHostPort(value);
  return value;
}

export function sharedWorkerScope(value: unknown): SharedWorkerScope {
  assertSharedWorkerScope(value);
  return value;
}

function assertWorkerHostPort(value: unknown): asserts value is WorkerHostPort {
  if (
    isRecord(value) &&
    typeof value.postMessage === "function" &&
    typeof value.addEventListener === "function" &&
    (!("start" in value) ||
      value.start === undefined ||
      typeof value.start === "function")
  ) {
    return;
  }
  throw new Error("invalid dedicated worker scope");
}

function assertSharedWorkerScope(
  value: unknown,
): asserts value is SharedWorkerScope {
  if (
    isRecord(value) &&
    "onconnect" in value &&
    (value.onconnect === null || typeof value.onconnect === "function")
  ) {
    return;
  }
  throw new Error("invalid shared worker scope");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
