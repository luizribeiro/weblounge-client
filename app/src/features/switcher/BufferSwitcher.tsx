import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type {
  BufferProjection,
  NetworkProjection,
} from "../../engine/protocol";
import { t } from "../../strings";
import { Line } from "../../ui/Line";
import { OmnibarOverlay } from "../../ui/OmnibarOverlay";
import { unreadBadge } from "../unread/unread-badge";
import styles from "./BufferSwitcher.module.css";
import {
  moveSwitcherSelection,
  type SwitcherBuffer,
  switcherBuffers,
  switcherKeyIntent,
} from "./buffer-switcher-model";

interface BufferSwitcherProps {
  readonly buffers: readonly BufferProjection[];
  readonly networks: readonly NetworkProjection[];
  readonly recentBufferIds: readonly number[];
  readonly onDismiss: () => void;
  readonly onOpen: (bufferId: number) => void;
}

const listboxId = "buffer-switcher-results";

export function BufferSwitcher(props: BufferSwitcherProps) {
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const results = createMemo(() =>
    switcherBuffers(
      props.buffers,
      props.networks,
      props.recentBufferIds,
      query(),
    ),
  );
  let restoreInvoker = true;
  const optionId = (bufferId: number) => `buffer-switcher-option-${bufferId}`;
  const active = () => results()[selected()];

  createEffect(() => {
    const count = results().length;
    if (count === 0) setSelected(0);
    else if (selected() >= count) setSelected(count - 1);
  });
  createEffect(() => {
    const current = active();
    if (current === undefined) return;
    queueMicrotask(() =>
      document
        .getElementById(optionId(current.buffer.id))
        ?.scrollIntoView?.({ block: "nearest" }),
    );
  });

  const open = (item: SwitcherBuffer | undefined) => {
    if (item === undefined) return;
    restoreInvoker = false;
    props.onOpen(item.buffer.id);
  };
  const keydown = (event: KeyboardEvent) => {
    const intent = switcherKeyIntent(event);
    if (intent === undefined) return false;
    event.preventDefault();
    event.stopPropagation();
    if (intent === "dismiss") props.onDismiss();
    else if (intent === "open") open(active());
    else
      setSelected((current) =>
        moveSwitcherSelection(
          current,
          results().length,
          intent === "next" ? 1 : -1,
        ),
      );
    return true;
  };

  return (
    <OmnibarOverlay
      activeDescendant={
        active() === undefined ? undefined : optionId(active()?.buffer.id ?? 0)
      }
      closeLabel={t("switcher.close")}
      escapeHint={t("switcher.escape")}
      inputLabel={t("switcher.input")}
      label={t("switcher.dialog")}
      listboxId={listboxId}
      onDismiss={props.onDismiss}
      onInput={(value) => {
        setQuery(value);
        setSelected(0);
      }}
      onKeyDown={keydown}
      placeholder={t("switcher.placeholder")}
      query={query()}
      shouldRestoreFocus={() => restoreInvoker}
    >
      <div
        aria-label={t("switcher.results")}
        class={styles.results}
        id={listboxId}
        role="listbox"
      >
        <For each={results()}>
          {(item, index) => {
            const badge = () => unreadBadge(item.buffer);
            return (
              <button
                aria-label={optionLabel(item, badge()?.label)}
                aria-selected={index() === selected()}
                class={styles.option}
                data-buffer-id={item.buffer.id}
                id={optionId(item.buffer.id)}
                onClick={() => open(item)}
                onPointerDown={(event) => event.preventDefault()}
                role="option"
                tabIndex={-1}
                type="button"
              >
                <span aria-hidden="true" class={styles.glyph}>
                  {item.buffer.kind === "channel" ? "#" : "@"}
                </span>
                <Line class={styles.title}>{displayTitle(item.buffer)}</Line>
                <Line class={styles.network}>{item.network}</Line>
                <Show when={badge()} keyed>
                  {(current) => (
                    <Line
                      aria-label={current.label}
                      class={`${styles.badge} ${
                        current.kind === "mention" ? styles.mention : ""
                      }`}
                    >
                      {current.count}
                    </Line>
                  )}
                </Show>
              </button>
            );
          }}
        </For>
        <Show when={results().length === 0}>
          <p class={styles.empty}>{t("switcher.empty")}</p>
        </Show>
      </div>
    </OmnibarOverlay>
  );
}

function displayTitle(buffer: BufferProjection): string {
  return buffer.kind === "channel" ? buffer.title.slice(1) : buffer.title;
}

function optionLabel(item: SwitcherBuffer, badge: string | undefined): string {
  return [item.buffer.title, item.network, badge].filter(Boolean).join(", ");
}
