import {
  type Accessor,
  createEffect,
  createMemo,
  For,
  onCleanup,
  Show,
} from "solid-js";
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
  readonly restoreScroll: Accessor<number>;
  readonly restoreVersion: Accessor<number>;
  readonly onFilter: (filter: ChatFilter) => void;
  readonly onOpen: (bufferId: number, scrollTop: number) => void;
  readonly onQuery: (query: string) => void;
  readonly onRetryNetwork?: ((networkId: number) => void) | undefined;
  readonly onScroll: (scrollTop: number) => void;
}

export function MobileChatList(props: MobileChatListProps) {
  let list: HTMLDivElement | undefined;
  let restoringScroll = false;
  let userScrollIntent = false;
  let scrollTopBeforeOpen = 0;
  const markUserScrollIntent = () => {
    userScrollIntent = true;
  };
  const markScrollKeyIntent = (event: KeyboardEvent) => {
    if (scrollKeys.has(event.key)) userScrollIntent = true;
  };
  const chats = createMemo(() =>
    filterChats(props.buffers, props.filter, props.query),
  );
  const chatsById = createMemo(
    () => new Map(chats().map((buffer) => [buffer.id, buffer])),
  );
  const chatIds = createMemo(() => [...chatsById().keys()]);
  const failedNetwork = () =>
    props.networks.find(
      (network) => connectionStateKind(network.state) === "failed",
    );
  const connection = () => connectionOverview(props.networks);
  createEffect(() => {
    props.restoreVersion();
    const scrollTop = props.restoreScroll();
    if (list === undefined) return;
    userScrollIntent = false;
    const element = list;
    restoringScroll = true;
    element.scrollTop = scrollTop;
    let releaseFrame: number | undefined;
    const restoreFrame = requestAnimationFrame(() => {
      element.scrollTop = scrollTop;
      releaseFrame = requestAnimationFrame(() => {
        restoringScroll = false;
      });
    });
    onCleanup(() => {
      cancelAnimationFrame(restoreFrame);
      if (releaseFrame !== undefined) cancelAnimationFrame(releaseFrame);
    });
  });
  onCleanup(() => {
    list?.removeEventListener("keydown", markScrollKeyIntent);
    list?.removeEventListener("pointermove", markUserScrollIntent);
    list?.removeEventListener("wheel", markUserScrollIntent);
  });
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
        data-mobile-chat-list="true"
        onScroll={(event) => {
          if (!restoringScroll && userScrollIntent)
            props.onScroll(event.currentTarget.scrollTop);
        }}
        ref={(element) => {
          list = element;
          element.addEventListener("keydown", markScrollKeyIntent);
          element.addEventListener("pointermove", markUserScrollIntent, {
            passive: true,
          });
          element.addEventListener("wheel", markUserScrollIntent, {
            passive: true,
          });
        }}
      >
        <For each={chatIds()}>
          {(bufferId) => {
            const buffer = () => chatsById().get(bufferId);
            return (
              <Show when={buffer()}>
                {(current) => (
                  <MobileChatRow
                    buffer={current()}
                    previews={mobilePreviews()}
                    networkLabel={networkLabel(
                      props.networks,
                      current().network_id,
                    )}
                    onOpen={() => {
                      userScrollIntent = false;
                      props.onOpen(current().id, scrollTopBeforeOpen);
                    }}
                    onPressStart={() => {
                      scrollTopBeforeOpen = list?.scrollTop ?? 0;
                    }}
                  />
                )}
              </Show>
            );
          }}
        </For>
        <Show when={chats().length === 0}>
          <p class={styles.empty}>No chats match this view.</p>
        </Show>
      </div>
    </section>
  );
}

const scrollKeys = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);

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
