import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type {
  ActionContext,
  ActionRegistry,
  UiActionId,
} from "../../actions/action-registry";
import { connectionPresentation } from "../../engine/connection-state";
import type { NetworkProjection } from "../../engine/protocol";
import { platformEnvironment } from "../../platform/environment";
import { t } from "../../strings";
import { ConnectionErrorStrip } from "../../ui/ConnectionErrorStrip";
import {
  connectionSweepAtRest,
  createConnectionProgress,
} from "../../ui/connection-progress";
import { Line } from "../../ui/Line";
import {
  NotificationPrompt,
  type NotificationPromptControls,
} from "../notifications/NotificationPrompt";
import { NetworkSection, type SidebarBuffer } from "./NetworkSection";
import styles from "./Sidebar.module.css";
import { SidebarFooter } from "./SidebarFooter";

export interface SidebarListController {
  readonly next: () => void;
  readonly open: () => void;
  readonly previous: () => void;
}

interface SidebarProps extends NotificationPromptControls {
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
  const platform = platformEnvironment();
  let brand: HTMLDivElement | undefined;
  const [rovingId, setRovingId] = createSignal<number>();
  const elements = new Map<number, HTMLButtonElement>();
  const orderedIds = () => orderedBuffers(props.networks, props.buffers);
  const connection = () => connectionPresentation(props.networks);
  const progress = createConnectionProgress(() => connection().progressing, {
    atRest: () => connectionSweepAtRest(brand),
    interrupted: () => connection().error !== undefined,
    mode: "sweep-then-fill",
    prefersReducedMotion: platform.prefersReducedMotion,
  });
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
    <aside
      aria-label={t("sidebar.channel_list")}
      class={styles.sidebar}
      data-sidebar="true"
    >
      <div
        class={styles.brand}
        data-connection-brand="true"
        data-connection-shimmer="true"
        data-connection-phase={
          progress.phase() === "idle" ? undefined : progress.phase()
        }
        data-connection-progress={progress.active() || undefined}
        data-connection-visible={platform.pageVisible() || undefined}
        onAnimationEnd={progress.handleAnimationEnd}
        onAnimationIteration={progress.handleAnimationIteration}
        ref={brand}
      >
        <div
          class={styles.logo}
          data-connection-error={connection().error !== undefined || undefined}
          data-connection-logo="true"
        >
          <span
            aria-hidden="true"
            class={styles.logoMark}
            data-connection-logo-mark="true"
          />
          <span aria-hidden="true" data-connection-fill="true">
            <span class={styles.logoMark} data-connection-logo-mark="true" />
          </span>
        </div>
        <div class={styles.brandText}>
          <h1 data-connection-title="true">
            <Line>{t("common.weblounge")}</Line>
          </h1>
          <Line class={styles.summary}>{networkSummary(props.networks)}</Line>
        </div>
      </div>

      <Show when={connection().error} keyed>
        {(error) => (
          <ConnectionErrorStrip
            error={error}
            onAction={(networkId) => props.onRetryNetwork?.(networkId)}
          />
        )}
      </Show>

      <Show when={props.notificationPromptVisible}>
        <NotificationPrompt
          onDismiss={() => props.onDismissNotificationPrompt?.()}
          onTurnOn={() => props.onTurnOnNotifications?.()}
        />
      </Show>

      <nav
        aria-label={t("sidebar.navigation")}
        class={styles.navigation}
        data-command-scope="list"
      >
        <For each={props.networks}>
          {(network) => (
            <NetworkSection
              activeBufferId={props.activeBufferId}
              buffers={props.buffers.filter(
                (buffer) =>
                  buffer.network_id === network.id &&
                  buffer.available !== false,
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
      </nav>

      <SidebarFooter networks={props.networks} />
    </aside>
  );
}

function orderedBuffers(
  networks: readonly NetworkProjection[],
  buffers: readonly SidebarBuffer[],
): number[] {
  return networks.flatMap((network) =>
    buffers
      .filter(
        (buffer) =>
          buffer.network_id === network.id && buffer.available !== false,
      )
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
  return t(count === 1 ? "sidebar.network.one" : "sidebar.network.many", {
    count: String(count),
  });
}
