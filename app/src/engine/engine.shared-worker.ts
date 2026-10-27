import { sharedWorkerScope } from "./worker-globals";
import { attachEnginePort } from "./worker-runtime";

const scope = sharedWorkerScope(globalThis);

scope.onconnect = (event) => {
  const port = event.ports[0];
  if (port !== undefined) attachEnginePort(port);
};
