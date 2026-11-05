import { createMemo, For, Show } from "solid-js";
import { connectionStateKind } from "../../engine/connection-state";
import type {
  BufferProjection,
  NetworkProjection,
} from "../../engine/protocol";
import { t } from "../../strings";
import { Line } from "../../ui/Line";
import styles from "./Sidebar.module.css";
import { SidebarRow } from "./SidebarRow";

export type SidebarBuffer = BufferProjection & { readonly muted?: boolean };

interface NetworkSectionProps {
  readonly network: NetworkProjection;
  readonly buffers: readonly SidebarBuffer[];
  readonly activeBufferId: number | undefined;
  readonly rovingId: number | undefined;
  readonly visibleBufferIds: ReadonlySet<number>;
  readonly onFocus: (bufferId: number | undefined) => void;
  readonly onOpenBuffer: (buffer: SidebarBuffer) => void;
  readonly onOpenServer: (buffer: SidebarBuffer) => void;
  readonly registerElement: (
    bufferId: number | undefined,
    element: HTMLButtonElement,
  ) => void;
}

export function NetworkSection(props: NetworkSectionProps) {
  const server = () => props.buffers.find((buffer) => buffer.kind === "server");
  const conversations = () =>
    props.buffers.filter((buffer) => buffer.kind !== "server");
  const conversationsById = createMemo(
    () => new Map(conversations().map((buffer) => [buffer.id, buffer])),
  );
  const conversationIds = createMemo(() => [...conversationsById().keys()]);
  return (
    <section aria-label={props.network.label} class={styles.network}>
      {server() !== undefined && (
        <button
          aria-current={
            props.activeBufferId === server()?.id ? "page" : undefined
          }
          aria-label={t("sidebar.network_label", {
            network: props.network.label,
            state: t(
              `sidebar.network_state.${connectionStateKind(props.network.state)}`,
            ),
          })}
          class={styles.networkHeader}
          data-network-state={connectionStateKind(props.network.state)}
          onClick={() => {
            const buffer = server();
            if (buffer !== undefined) props.onOpenServer(buffer);
          }}
          onFocus={() => props.onFocus(server()?.id)}
          ref={(element) => props.registerElement(server()?.id, element)}
          tabIndex={props.rovingId === server()?.id ? 0 : -1}
          type="button"
        >
          <span aria-hidden="true" class={styles.tile}>
            {props.network.label.slice(0, 1).toLocaleUpperCase()}
          </span>
          <Line class={styles.networkName}>{props.network.label}</Line>
        </button>
      )}
      <div class={styles.rows}>
        <For each={conversationIds()}>
          {(bufferId) => {
            const buffer = () => conversationsById().get(bufferId);
            return (
              <Show when={buffer()}>
                {(current) => (
                  <SidebarRow
                    active={props.activeBufferId === current().id}
                    badgesSuppressed={props.visibleBufferIds.has(current().id)}
                    buffer={current()}
                    muted={current().muted === true}
                    onClick={() => props.onOpenBuffer(current())}
                    onFocus={() => props.onFocus(current().id)}
                    ref={(element) =>
                      props.registerElement(current().id, element)
                    }
                    tabIndex={props.rovingId === current().id ? 0 : -1}
                  />
                )}
              </Show>
            );
          }}
        </For>
      </div>
    </section>
  );
}
