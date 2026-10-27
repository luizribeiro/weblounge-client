export interface WorkerHostPort {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  start?: () => void;
}

interface WasmEngine {
  handle(message: string): string;
}

interface WasmModule {
  default: (module: string) => Promise<unknown>;
  WasmEngine: new (buildId: string, instanceId: string) => WasmEngine;
}

const wasmModuleUrl = "/engine.js";
const wasmBinaryUrl = "/engine_bg.wasm";
const engine = loadEngine();

export function attachEnginePort(port: WorkerHostPort): void {
  let pending = Promise.resolve();
  port.addEventListener("message", (event) => {
    pending = pending.then(() => handleMessage(port, event.data));
  });
  port.start?.();
}

async function handleMessage(
  port: WorkerHostPort,
  message: unknown,
): Promise<void> {
  try {
    const currentEngine = await engine;
    const encoded = currentEngine.handle(JSON.stringify(message));
    const events: unknown = JSON.parse(encoded);
    if (!Array.isArray(events))
      throw new Error("engine returned a non-array response");
    for (const event of events) port.postMessage(event);
  } catch {
    port.postMessage({ type: "fatal", message_key: "engine.worker_failed" });
  }
}

async function loadEngine(): Promise<WasmEngine> {
  const imported: unknown = await import(/* @vite-ignore */ wasmModuleUrl);
  if (!isWasmModule(imported)) throw new Error("invalid wasm module");
  await imported.default(wasmBinaryUrl);
  return new imported.WasmEngine(__BUILD_ID__, crypto.randomUUID());
}

function isWasmModule(value: unknown): value is WasmModule {
  if (!isRecord(value)) return false;
  return (
    typeof value.default === "function" &&
    typeof value.WasmEngine === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
