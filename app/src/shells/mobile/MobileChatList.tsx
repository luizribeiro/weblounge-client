import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import {
  type DensityId,
  densityDefaults,
  densityPresets,
} from "../../density/density";
import { connectionPresentation } from "../../engine/connection-state";
import type {
  BufferProjection,
  NetworkProjection,
} from "../../engine/protocol";
import {
  NotificationPrompt,
  type NotificationPromptControls,
} from "../../features/notifications/NotificationPrompt";
import { platformEnvironment } from "../../platform/environment";
import { t } from "../../strings";
import { ConnectionErrorStrip } from "../../ui/ConnectionErrorStrip";
import {
  connectionSweepAtRest,
  createConnectionProgress,
} from "../../ui/connection-progress";
import { Line } from "../../ui/Line";
import styles from "./MobileChatList.module.css";
import { MobileChatRow } from "./MobileChatRow";
import {
  type ChatFilter,
  chatFilters,
  filterChats,
  networkLabel,
} from "./mobile-chats";

interface MobileChatListProps extends NotificationPromptControls {
  readonly networks: readonly NetworkProjection[];
  readonly buffers: readonly BufferProjection[];
  readonly filter: ChatFilter;
  readonly query: string;
  readonly restoreScroll: Accessor<number>;
  readonly restoreVersion: Accessor<number>;
  readonly onFilter: (filter: ChatFilter) => void;
  readonly onOpen: (bufferId: number, scrollTop: number) => void;
  readonly onMarkRead?: ((buffer: BufferProjection) => void) | undefined;
  readonly onRequestActions?:
    | ((
        buffer: BufferProjection,
        rect: DOMRect,
        invoker: HTMLButtonElement,
      ) => void)
    | undefined;
  readonly onRequestClose?:
    | ((buffer: BufferProjection) => Promise<boolean>)
    | undefined;
  readonly onQuery: (query: string) => void;
  readonly onRetryNetwork?: ((networkId: number) => void) | undefined;
  readonly showConnectionError?: boolean | undefined;
  readonly onScroll: (scrollTop: number) => void;
}

export function MobileChatList(props: MobileChatListProps) {
  const platform = platformEnvironment();
  let header: HTMLElement | undefined;
  let list: HTMLDivElement | undefined;
  const [restoringScroll, setRestoringScroll] = createSignal(false);
  let userScrollIntent = false;
  let userScrollSequence = false;
  let scrollTopBeforeOpen = 0;
  let restoreFrame: number | undefined;
  let releaseFrame: number | undefined;
  const [rowPressed, setRowPressed] = createSignal(false);
  const [revealedRowId, setRevealedRowId] = createSignal<number>();
  const cancelScrollRestore = () => {
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame);
    if (releaseFrame !== undefined) cancelAnimationFrame(releaseFrame);
    restoreFrame = undefined;
    releaseFrame = undefined;
    setRestoringScroll(false);
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
    filterChats(
      props.buffers.filter((buffer) => buffer.available !== false),
      props.filter,
      props.query,
    ),
  );
  const chatsById = createMemo(
    () => new Map(chats().map((buffer) => [buffer.id, buffer])),
  );
  const latestChatIds = createMemo(() => [...chatsById().keys()]);
  const chatIds = createMemo<readonly number[]>((visible = []) =>
    rowPressed() ? visible : latestChatIds(),
  );
  const releasePressedRow = () => setRowPressed(false);
  const pressRow = (event: PointerEvent, bufferId: number) => {
    if (event.isPrimary !== false) setRowPressed(true);
    if (revealedRowId() !== bufferId) setRevealedRowId(undefined);
  };
  window.addEventListener("pointerup", releasePressedRow);
  window.addEventListener("pointercancel", releasePressedRow);
  const connection = () => connectionPresentation(props.networks);
  const progress = createConnectionProgress(() => connection().progressing, {
    atRest: () => connectionSweepAtRest(header),
    interrupted: () => connection().error !== undefined,
    mode: "sweep-then-fill",
    prefersReducedMotion: platform.prefersReducedMotion,
  });
  createEffect(() => {
    props.restoreVersion();
    const scrollTop = props.restoreScroll();
    if (list === undefined) return;
    cancelScrollRestore();
    userScrollIntent = false;
    userScrollSequence = false;
    scrollTopBeforeOpen = scrollTop;
    const element = list;
    setRestoringScroll(true);
    element.scrollTop = scrollTop;
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = undefined;
      element.scrollTop = scrollTop;
      releaseFrame = requestAnimationFrame(() => {
        releaseFrame = undefined;
        setRestoringScroll(false);
      });
    });
  });
  onCleanup(() => {
    cancelScrollRestore();
    list?.removeEventListener("keydown", markScrollKeyIntent);
    list?.removeEventListener("pointermove", markPointerScrollIntent);
    list?.removeEventListener("wheel", markWheelScrollIntent);
    window.removeEventListener("pointerup", releasePressedRow);
    window.removeEventListener("pointercancel", releasePressedRow);
  });
  return (
    <section
      aria-label={t("mobile.chats")}
      class={styles.root}
      data-mobile-chats="true"
    >
      <header
        class={styles.header}
        data-connection-brand="true"
        data-connection-shimmer="true"
        data-connection-phase={
          progress.phase() === "idle" ? undefined : progress.phase()
        }
        data-connection-progress={progress.active() || undefined}
        data-connection-visible={platform.pageVisible() || undefined}
        onAnimationEnd={progress.handleAnimationEnd}
        onAnimationIteration={progress.handleAnimationIteration}
        ref={header}
      >
        <span
          aria-hidden="true"
          class={styles.logo}
          data-connection-error={connection().error !== undefined || undefined}
          data-connection-logo="true"
        >
          <span
            class={styles.logoMark}
            data-connection-logo-mark="true"
            data-mobile-logo-mark="true"
          />
          <span data-connection-fill="true">
            <span class={styles.logoMark} data-connection-logo-mark="true" />
          </span>
        </span>
        <span class={styles.identity}>
          <h1 data-connection-title="true">
            <Line>{t("common.weblounge")}</Line>
          </h1>
        </span>
      </header>
      <Show
        when={props.showConnectionError !== false && connection().error}
        keyed
      >
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
      <label class={styles.search}>
        <span class="visually-hidden">{t("mobile.search")}</span>
        <input
          onInput={(event) => props.onQuery(event.currentTarget.value)}
          placeholder={t("mobile.search_placeholder")}
          type="search"
          value={props.query}
        />
      </label>
      <nav
        aria-label={t("mobile.filter.label")}
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
        data-restoring-scroll={restoringScroll() || undefined}
        onScroll={(event) => {
          if (!restoringScroll() && userScrollIntent) {
            userScrollIntent = false;
            scrollTopBeforeOpen = event.currentTarget.scrollTop;
            props.onScroll(event.currentTarget.scrollTop);
          }
        }}
        onScrollEnd={(event) => {
          if (!restoringScroll() && userScrollSequence) {
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
                    onMarkRead={() => props.onMarkRead?.(current())}
                    onPressStart={(event) => pressRow(event, current().id)}
                    onRequestActions={(rect, invoker) =>
                      props.onRequestActions?.(current(), rect, invoker)
                    }
                    onRequestClose={() => props.onRequestClose?.(current())}
                    onReset={() =>
                      setRevealedRowId((id) =>
                        id === current().id ? undefined : id,
                      )
                    }
                    onReveal={() => setRevealedRowId(current().id)}
                    revealed={revealedRowId() === current().id}
                  />
                )}
              </Show>
            );
          }}
        </For>
        <Show when={chats().length === 0}>
          <p class={styles.empty}>{t("mobile.empty")}</p>
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
