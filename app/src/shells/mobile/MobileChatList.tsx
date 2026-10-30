import { createMemo, For, Show } from "solid-js";
import {
  type DensityId,
  densityDefaults,
  densityPresets,
} from "../../density/density";
import {
  connectionOverview,
  connectionStateKind,
  connectionSummary,
} from "../../engine/connection-state";
import type {
  BufferProjection,
  NetworkProjection,
} from "../../engine/protocol";
import { Line } from "../../ui/Line";
import styles from "./MobileChatList.module.css";
import { MobileChatRow } from "./MobileChatRow";
import {
  type ChatFilter,
  chatFilters,
  filterChats,
  networkLabel,
} from "./mobile-chats";

interface MobileChatListProps {
  readonly networks: readonly NetworkProjection[];
  readonly buffers: readonly BufferProjection[];
  readonly filter: ChatFilter;
  readonly query: string;
  readonly scrollTop: number;
  readonly onFilter: (filter: ChatFilter) => void;
  readonly onOpen: (bufferId: number) => void;
  readonly onQuery: (query: string) => void;
  readonly onRetryNetwork?: ((networkId: number) => void) | undefined;
  readonly onScroll: (scrollTop: number) => void;
}

export function MobileChatList(props: MobileChatListProps) {
  const chats = createMemo(() =>
    filterChats(props.buffers, props.filter, props.query),
  );
  const failedNetwork = () =>
    props.networks.find(
      (network) => connectionStateKind(network.state) === "failed",
    );
  const connection = () => connectionOverview(props.networks);
  return (
    <section aria-label="Chats" class={styles.root} data-mobile-chats="true">
      <header class={styles.header}>
        <span aria-hidden="true" class={styles.logo}>
          <span class={styles.logoMark} />
        </span>
        <span class={styles.identity}>
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
              Offline · Retry
            </button>
          ) : connectionSummary(props.networks) !== "" ? (
            <Line
              class={styles.status}
              data-connection-status={connectionSummary(props.networks)}
            >
              <span
                aria-hidden="true"
                class={styles.statusDot}
                data-connection-color={connection().colorToken}
              />
              {connectionSummary(props.networks)}
            </Line>
          ) : null}
        </span>
      </header>
      <label class={styles.search}>
        <span class="visually-hidden">Search chats</span>
        <input
          onInput={(event) => props.onQuery(event.currentTarget.value)}
          placeholder="Search channels and people"
          type="search"
          value={props.query}
        />
      </label>
      <nav
        aria-label="Chat filters"
        class={styles.filters}
        data-horizontal-scroll="true"
      >
        <For each={chatFilters}>
          {(item) => (
            <button
              aria-pressed={props.filter === item.id}
              class={styles.filter}
              onClick={() => props.onFilter(item.id)}
              type="button"
            >
              {item.label}
            </button>
          )}
        </For>
      </nav>
      <div
        class={styles.list}
        onScroll={(event) => props.onScroll(event.currentTarget.scrollTop)}
        ref={(element) => {
          queueMicrotask(() => {
            element.scrollTop = props.scrollTop;
          });
        }}
      >
        <For each={chats()}>
          {(buffer) => (
            <MobileChatRow
              buffer={buffer}
              previews={mobilePreviews()}
              networkLabel={networkLabel(props.networks, buffer.network_id)}
              onOpen={() => props.onOpen(buffer.id)}
            />
          )}
        </For>
        <Show when={chats().length === 0}>
          <p class={styles.empty}>No chats match this view.</p>
        </Show>
      </div>
    </section>
  );
}

function mobilePreviews(): boolean {
  const configured = document.documentElement.dataset.mobileDensity;
  const density: DensityId = isDensity(configured)
    ? configured
    : densityDefaults.mobileList;
  return densityPresets[density].mobilePreviews;
}

function isDensity(value: string | undefined): value is DensityId {
  return value === "compact" || value === "cozy" || value === "comfortable";
}
