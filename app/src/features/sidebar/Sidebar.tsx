import { createEffect, createSignal, For, onCleanup } from "solid-js";
import type {
  ActionContext,
  ActionRegistry,
  UiActionId,
} from "../../actions/action-registry";
import {
  connectionStateKind,
  connectionSummary,
} from "../../engine/connection-state";
import type { NetworkProjection } from "../../engine/protocol";
import { Line } from "../../ui/Line";
import { NetworkSection, type SidebarBuffer } from "./NetworkSection";
import styles from "./Sidebar.module.css";
import { SidebarFooter } from "./SidebarFooter";

export interface SidebarListController {
  readonly next: () => void;
  readonly open: () => void;
  readonly previous: () => void;
}

interface SidebarProps {
  readonly networks: readonly NetworkProjection[];
  readonly buffers: readonly SidebarBuffer[];
  readonly activeBufferId?: number | undefined;
  readonly visibleBufferIds: ReadonlySet<number>;
  readonly registry: ActionRegistry;
  readonly commandContext: ActionContext;
  readonly registerListController: (
    controller: SidebarListController | undefined,
  ) => void;
  readonly onRetryNetwork?: ((networkId: number) => void) | undefined;
}

export function Sidebar(props: SidebarProps) {
  const [rovingId, setRovingId] = createSignal<number>();
  const elements = new Map<number, HTMLButtonElement>();
  const orderedIds = () => orderedBuffers(props.networks, props.buffers);
  const failedNetwork = () =>
    props.networks.find(
      (network) => connectionStateKind(network.state) === "failed",
    );
  const run = (id: UiActionId, target?: SidebarBuffer) =>
    props.registry.run(id, {
      ...props.commandContext,
      ...(target === undefined
        ? {}
        : {
            targetBufferId: target.id,
            targetNetworkId: target.network_id,
          }),
    });
  const move = (offset: -1 | 1) => {
    const ids = orderedIds();
    if (ids.length === 0) return;
    const first = ids[0];
    if (first === undefined) return;
    const current = rovingId() ?? props.activeBufferId ?? first;
    const index = Math.max(0, ids.indexOf(current));
    const target = ids[(index + offset + ids.length) % ids.length];
    if (target === undefined) return;
    setRovingId(target);
    elements.get(target)?.focus();
  };
  const controller: SidebarListController = {
    next: () => move(1),
    previous: () => move(-1),
    open: () => {
      const id = rovingId() ?? props.activeBufferId;
      if (id !== undefined) elements.get(id)?.click();
    },
  };
  props.registerListController(controller);
  onCleanup(() => props.registerListController(undefined));

  createEffect(() => {
    const ids = orderedIds();
    if (
      props.activeBufferId !== undefined &&
      ids.includes(props.activeBufferId)
    ) {
      setRovingId(props.activeBufferId);
    } else if (!ids.includes(rovingId() ?? -1)) {
      setRovingId(ids[0]);
    }
  });

  return (
    <aside aria-label="Channel list" class={styles.sidebar} data-sidebar="true">
      <div class={styles.brand}>
        <div class={styles.logo}>
          <span aria-hidden="true" class={styles.logoMark} />
        </div>
        <div class={styles.brandText}>
          <h1>
            <Line>weblounge</Line>
          </h1>
          {failedNetwork() !== undefined ? (
            <button
              class={styles.retry}
              data-connection-status={connectionSummary(props.networks)}
              onClick={() => props.onRetryNetwork?.(failedNetwork()?.id ?? 0)}
              type="button"
            >
              {networkSummary(props.networks)}
            </button>
          ) : (
            <Line
              class={styles.summary}
              data-connection-status={
                connectionSummary(props.networks) || undefined
              }
            >
              {networkSummary(props.networks)}
            </Line>
          )}
        </div>
      </div>

      <button
        class={styles.jump}
        onClick={() => run("switcher.open")}
        title={tooltip(props.registry, "switcher.open")}
        type="button"
      >
        <Line>Jump to…</Line>
        <Line class={styles.binding}>
          {props.registry.bindingLabel("switcher.open")}
        </Line>
      </button>

      <nav
        aria-label="Networks and buffers"
        class={styles.navigation}
        data-command-scope="list"
      >
        <For each={props.networks}>
          {(network) => (
            <NetworkSection
              activeBufferId={props.activeBufferId}
              buffers={props.buffers.filter(
                (buffer) => buffer.network_id === network.id,
              )}
              network={network}
              onFocus={setRovingId}
              onOpenBuffer={(buffer) => run("pane.show-buffer", buffer)}
              onOpenServer={(buffer) => run("network.open-server", buffer)}
              registerElement={(id, element) => {
                if (id !== undefined) elements.set(id, element);
              }}
              rovingId={rovingId()}
              visibleBufferIds={props.visibleBufferIds}
            />
          )}
        </For>
        <button
          class={styles.addNetwork}
          onClick={() => run("network.add")}
          type="button"
        >
          <span aria-hidden="true">+</span>
          <Line>Add network</Line>
        </button>
      </nav>

      <SidebarFooter
        networks={props.networks}
        onOpenSettings={() => run("settings.open")}
        settingsTooltip={tooltip(props.registry, "settings.open")}
      />
    </aside>
  );
}

function orderedBuffers(
  networks: readonly NetworkProjection[],
  buffers: readonly SidebarBuffer[],
): number[] {
  return networks.flatMap((network) =>
    buffers
      .filter((buffer) => buffer.network_id === network.id)
      .sort((first, second) => kindOrder(first) - kindOrder(second))
      .map((buffer) => buffer.id),
  );
}

function kindOrder(buffer: SidebarBuffer): number {
  if (buffer.kind === "server") return 0;
  if (buffer.kind === "channel") return 1;
  return 2;
}

function networkSummary(networks: readonly NetworkProjection[]): string {
  const count = networks.length;
  const countLabel = `${count} ${count === 1 ? "network" : "networks"}`;
  const status = connectionSummary(networks);
  return status === "" ? countLabel : `${countLabel} · ${status}`;
}

function tooltip(registry: ActionRegistry, id: UiActionId): string {
  const binding = registry.bindingLabel(id);
  return binding === undefined
    ? registry.title(id)
    : `${registry.title(id)} (${binding})`;
}
