import { For } from "solid-js";
import type {
  BufferProjection,
  NetworkProjection,
} from "../../engine/protocol";
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
  return (
    <section aria-label={props.network.label} class={styles.network}>
      {server() !== undefined && (
        <button
          aria-current={
            props.activeBufferId === server()?.id ? "page" : undefined
          }
          aria-label={`${props.network.label}, ${props.network.state}`}
          class={styles.networkHeader}
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
          <span
            aria-hidden="true"
            class={styles.statusDot}
            data-network-state={props.network.state}
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
              onClick={() => props.onOpenBuffer(buffer)}
              onFocus={() => props.onFocus(buffer.id)}
              ref={(element) => props.registerElement(buffer.id, element)}
              tabIndex={props.rovingId === buffer.id ? 0 : -1}
            />
          )}
        </For>
      </div>
    </section>
  );
}
