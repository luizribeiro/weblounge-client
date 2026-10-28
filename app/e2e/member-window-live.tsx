import { createSignal, For, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import { installDensity } from "../src/density/density";
import {
  type EngineConnection,
  WorkerEngineClient,
} from "../src/engine/EngineClient";
import {
  MemberPanel,
  type MemberWindow,
} from "../src/features/members/MemberPanel";
import "../src/styles/base.css";
import { installSystemTheme } from "../src/theme/theme-controller";
import { FakeMemberPort } from "./fake-member-engine";

const port = new FakeMemberPort();
const connection: EngineConnection = { port, close() {} };
const client = new WorkerEngineClient(connection);
const root = document.getElementById("root");
if (root === null) throw new Error("missing live member root");
installDensity(document);
installSystemTheme(document, window);
render(() => <Harness />, root);
void client.start({
  build_id: "fake",
  client_id: "browser",
  last_revision: null,
  shell: "web",
});

function Harness() {
  const [windows, setWindows] = createSignal<ReadonlyMap<string, MemberWindow>>(
    new Map(),
  );
  const [patches, setPatches] = createSignal(0);
  const unsubscribe = client.subscribe((message) => {
    if (message.type !== "members_changed") return;
    setWindows((current) => new Map(current).set(message.view_id, message));
  });
  onCleanup(unsubscribe);
  const request = (viewId: string, offset: number) => {
    void client.send({
      id: crypto.randomUUID(),
      request: {
        type: "request_members",
        buffer_id: 1,
        view_id: viewId,
        offset,
      },
    });
  };
  return (
    <>
      <nav>
        <For each={["join", "mode", "split"] as const}>
          {(change) => (
            <button
              onClick={() => {
                port.change(change);
                setPatches(port.patches);
              }}
              type="button"
            >
              {change}
            </button>
          )}
        </For>
        <output data-patches>{patches()}</output>
      </nav>
      <div style={{ display: "flex", height: "700px" }}>
        <For each={["left", "right"]}>
          {(viewId) => {
            const current = () => windows().get(viewId);
            return (
              <section data-member-view={viewId} style={{ display: "flex" }}>
                <output data-offset>{current()?.offset ?? -1}</output>
                <output data-version>{current()?.version ?? -1}</output>
                <output data-first>{current()?.members[0]?.nick ?? ""}</output>
                <MemberPanel
                  bufferTitle="#large"
                  onClose={() => {}}
                  onOpenDirect={() => {}}
                  onRequestRange={(offset) => request(viewId, offset)}
                  window={current()}
                />
              </section>
            );
          }}
        </For>
      </div>
    </>
  );
}
