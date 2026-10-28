import { createEffect, createSignal, For, onCleanup } from "solid-js";
import type {
  CommandContext,
  CommandId,
  CommandRegistry,
} from "../../commands/command-registry";
import type {
  BufferProjection,
  NetworkProjection,
} from "../../engine/protocol";
import { Line } from "../../ui/Line";
import styles from "./Sidebar.module.css";
import { SidebarRow } from "./SidebarRow";

type SidebarBuffer = BufferProjection & { readonly muted?: boolean };

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
  readonly registry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly registerListController: (
    controller: SidebarListController | undefined,
  ) => void;
}

export function Sidebar(props: SidebarProps) {
  const [rovingId, setRovingId] = createSignal<number>();
  const elements = new Map<number, HTMLButtonElement>();
  const orderedIds = () => orderedBuffers(props.networks, props.buffers);
  const run = (id: CommandId, target?: SidebarBuffer) =>
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
          <Line class={styles.summary}>{networkSummary(props.networks)}</Line>
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
          {(network) => {
            const networkBuffers = () =>
              props.buffers.filter(
                (buffer) => buffer.network_id === network.id,
              );
            const server = () =>
              networkBuffers().find((buffer) => buffer.kind === "server");
            const conversations = () =>
              networkBuffers().filter((buffer) => buffer.kind !== "server");
            return (
              <section aria-label={network.label} class={styles.network}>
                {server() !== undefined && (
                  <button
                    aria-current={
                      props.activeBufferId === server()?.id ? "page" : undefined
                    }
                    aria-label={`${network.label}, ${network.state}`}
                    class={styles.networkHeader}
                    onClick={() => run("network.open-server", server())}
                    onFocus={() => setRovingId(server()?.id)}
                    ref={(element) => {
                      const id = server()?.id;
                      if (id !== undefined) elements.set(id, element);
                    }}
                    tabIndex={rovingId() === server()?.id ? 0 : -1}
                    type="button"
                  >
                    <span aria-hidden="true" class={styles.tile}>
                      {network.label.slice(0, 1).toLocaleUpperCase()}
                    </span>
                    <Line class={styles.networkName}>{network.label}</Line>
                    <span
                      aria-hidden="true"
                      class={styles.statusDot}
                      data-network-state={network.state}
                    />
                  </button>
                )}
                <div class={styles.rows}>
                  <For each={conversations()}>
                    {(buffer) => (
                      <SidebarRow
                        active={props.activeBufferId === buffer.id}
                        badgesSuppressed={props.visibleBufferIds.has(buffer.id)}
                        buffer={buffer}
                        muted={buffer.muted === true}
                        onClick={() => run("pane.show-buffer", buffer)}
                        onFocus={() => setRovingId(buffer.id)}
                        ref={(element) => elements.set(buffer.id, element)}
                        tabIndex={rovingId() === buffer.id ? 0 : -1}
                      />
                    )}
                  </For>
                </div>
              </section>
            );
          }}
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

      <footer class={styles.footer}>
        <span aria-hidden="true" class={styles.userDot} />
        <div class={styles.userIdentity}>
          <Line class={styles.nickname}>
            {props.networks[0]?.nickname ?? "Offline"}
          </Line>
          <Line class={styles.userStatus}>{footerStatus(props.networks)}</Line>
        </div>
        <button
          aria-label="Settings"
          class={styles.settings}
          onClick={() => run("settings.open")}
          title={tooltip(props.registry, "settings.open")}
          type="button"
        >
          <span aria-hidden="true">⚙</span>
        </button>
      </footer>
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
  return `${count} ${count === 1 ? "network" : "networks"} · ${footerStatus(networks)}`;
}

function footerStatus(networks: readonly NetworkProjection[]): string {
  if (
    networks.some(
      (network) =>
        network.state === "connecting" || network.state === "reconnecting",
    )
  ) {
    return "connecting";
  }
  return networks.some((network) => network.state === "online")
    ? "connected"
    : "offline";
}

function tooltip(registry: CommandRegistry, id: CommandId): string {
  const binding = registry.bindingLabel(id);
  return binding === undefined
    ? registry.title(id)
    : `${registry.title(id)} (${binding})`;
}
