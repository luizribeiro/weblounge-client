import { createMemo, For, Show } from "solid-js";
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
  connectionSummary,
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
  readonly onScroll: (scrollTop: number) => void;
}

export function MobileChatList(props: MobileChatListProps) {
  const chats = createMemo(() =>
    filterChats(props.buffers, props.filter, props.query),
  );
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
          <Line class={styles.status}>
            <span aria-hidden="true" class={styles.statusDot} />
            {connectionSummary(props.networks)}
          </Line>
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
      <nav aria-label="Chat filters" class={styles.filters}>
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
          element.scrollTop = props.scrollTop;
        }}
      >
        <For each={chats()}>
          {(buffer) => (
            <MobileChatRow
              buffer={buffer}
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
