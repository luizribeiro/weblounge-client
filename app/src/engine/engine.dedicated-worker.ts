import { attachEnginePort, type WorkerHostPort } from "./worker-runtime";

attachEnginePort(globalThis as unknown as WorkerHostPort);
