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
  let userScrollSequence = false;
  let scrollTopBeforeOpen = 0;
  let restoreFrame: number | undefined;
  let releaseFrame: number | undefined;
  const cancelScrollRestore = () => {
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame);
    if (releaseFrame !== undefined) cancelAnimationFrame(releaseFrame);
    restoreFrame = undefined;
    releaseFrame = undefined;
    restoringScroll = false;
  };
  const markUserScrollIntent = (continuesThroughScrollEnd: boolean) => {
    cancelScrollRestore();
    userScrollIntent = true;
    userScrollSequence = continuesThroughScrollEnd;
  };
  const markPointerScrollIntent = () => markUserScrollIntent(true);
  const markWheelScrollIntent = () => markUserScrollIntent(false);
  const markScrollKeyIntent = (event: KeyboardEvent) => {
    if (scrollKeys.has(event.key)) markUserScrollIntent(false);
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
    cancelScrollRestore();
    userScrollIntent = false;
    userScrollSequence = false;
    scrollTopBeforeOpen = scrollTop;
    const element = list;
    restoringScroll = true;
    element.scrollTop = scrollTop;
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = undefined;
      element.scrollTop = scrollTop;
      releaseFrame = requestAnimationFrame(() => {
        releaseFrame = undefined;
        restoringScroll = false;
      });
    });
  });
  onCleanup(() => {
    cancelScrollRestore();
    list?.removeEventListener("keydown", markScrollKeyIntent);
    list?.removeEventListener("pointermove", markPointerScrollIntent);
    list?.removeEventListener("wheel", markWheelScrollIntent);
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
          if (!restoringScroll && userScrollIntent) {
            userScrollIntent = false;
            scrollTopBeforeOpen = event.currentTarget.scrollTop;
            props.onScroll(event.currentTarget.scrollTop);
          }
        }}
        onScrollEnd={(event) => {
          if (!restoringScroll && userScrollSequence) {
            userScrollIntent = false;
            userScrollSequence = false;
            scrollTopBeforeOpen = event.currentTarget.scrollTop;
            props.onScroll(event.currentTarget.scrollTop);
          }
        }}
        ref={(element) => {
          list = element;
          element.addEventListener("keydown", markScrollKeyIntent);
          element.addEventListener("pointermove", markPointerScrollIntent, {
            passive: true,
          });
          element.addEventListener("wheel", markWheelScrollIntent, {
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
                      userScrollSequence = false;
                      props.onOpen(current().id, scrollTopBeforeOpen);
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
