import { attachEnginePort } from "./worker-runtime";

interface SharedWorkerConnectEvent extends Event {
  readonly ports: readonly MessagePort[];
}

interface SharedWorkerScope {
  onconnect: ((event: SharedWorkerConnectEvent) => void) | null;
}

const scope = globalThis as unknown as SharedWorkerScope;

scope.onconnect = (event) => {
  const port = event.ports[0];
  if (port !== undefined) attachEnginePort(port);
};
