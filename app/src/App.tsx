import { createSignal, onCleanup, onMount } from "solid-js";
import { createEngineClient } from "./engine/createEngineClient";
import type { EngineClient } from "./engine/EngineClient";
import { IncompatibleBuildError } from "./engine/EngineClient";

const reloadMarker = "weblounge-build-reload";

interface AppProps {
  engineClient?: EngineClient;
}

export function App(props: AppProps) {
  const [engineStatus, setEngineStatus] = createSignal("Starting engine…");
  const [engineNotice, setEngineNotice] = createSignal<string>();

  onMount(() => {
    const client = props.engineClient ?? createEngineClient();
    const unsubscribe = client.subscribe((message) => {
      if (message.type === "diagnostic") {
        setEngineStatus(`Engine ready: ${message.message}`);
      }
      if (message.type === "notice") {
        setEngineNotice(
          "This browser uses one connection per tab because SharedWorker is unavailable.",
        );
      }
    });
    const updateVisibility = () => {
      client.setVisibility(document.hidden ? "hidden" : "visible");
    };
    document.addEventListener("visibilitychange", updateVisibility);
    updateVisibility();

    void startEngine(client, setEngineStatus);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", updateVisibility);
      unsubscribe();
      void client.close();
    });
  });

  return (
    <main>
      <h1>weblounge</h1>
      <p role="status">{engineStatus()}</p>
      {engineNotice() !== undefined && <p role="note">{engineNotice()}</p>}
    </main>
  );
}

async function startEngine(
  client: EngineClient,
  setStatus: (status: string) => void,
): Promise<void> {
  try {
    await client.start({
      build_id: __BUILD_ID__,
      client_id: crypto.randomUUID(),
      last_revision: null,
      shell: "web",
    });
    sessionStorage.removeItem(reloadMarker);
    await client.send({
      id: crypto.randomUUID(),
      command: {
        type: "diagnostic",
        message: "wasm worker round trip complete",
      },
    });
  } catch (error: unknown) {
    if (error instanceof IncompatibleBuildError) {
      recoverFromBuildMismatch(setStatus);
      return;
    }
    setStatus("Engine failed to start");
  }
}

function recoverFromBuildMismatch(setStatus: (status: string) => void): void {
  if (sessionStorage.getItem(reloadMarker) === __BUILD_ID__) {
    setStatus("Engine update failed; reload site data to recover");
    return;
  }

  sessionStorage.setItem(reloadMarker, __BUILD_ID__);
  location.reload();
}
