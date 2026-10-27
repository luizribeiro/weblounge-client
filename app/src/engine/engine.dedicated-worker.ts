import { workerHostPort } from "./worker-globals";
import { attachEnginePort } from "./worker-runtime";

attachEnginePort(workerHostPort(globalThis));
