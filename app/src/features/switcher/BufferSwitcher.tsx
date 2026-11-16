import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { ActionEntry, ActionId } from "../../actions/action-registry";
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
import {
  commandQuery,
  omnibarMode,
  paletteActions,
} from "./command-palette-model";
import { OmnibarRow } from "./OmnibarRow";

interface BufferSwitcherProps {
  readonly buffers: readonly BufferProjection[];
  readonly actions: readonly ActionEntry[];
  readonly initialMode?: "buffers" | "commands";
  readonly networks: readonly NetworkProjection[];
  readonly recentActionIds: readonly ActionId[];
  readonly recentBufferIds: readonly number[];
  readonly onDismiss: () => void;
  readonly onOpen: (bufferId: number) => void;
  readonly onRunAction: (actionId: ActionId) => boolean;
}

const listboxId = "omnibar-results";

export function BufferSwitcher(props: BufferSwitcherProps) {
  const [query, setQuery] = createSignal(
    props.initialMode === "commands" ? ">" : "",
  );
  const [selected, setSelected] = createSignal(0);
  const mode = createMemo(() => omnibarMode(query()));
  const bufferResults = createMemo(() =>
    switcherBuffers(
      props.buffers,
      props.networks,
      props.recentBufferIds,
      query(),
    ),
  );
  const actionResults = createMemo(() =>
    paletteActions(props.actions, props.recentActionIds, commandQuery(query())),
  );
  const resultCount = () =>
    mode() === "commands" ? actionResults().length : bufferResults().length;
  let restoreInvoker = true;
  const optionId = (bufferId: number) => `buffer-switcher-option-${bufferId}`;
  const actionOptionId = (action: ActionEntry) =>
    `command-palette-option-${action.id.replaceAll(".", "-")}`;
  const activeBuffer = () => bufferResults()[selected()];
  const activeAction = () => actionResults()[selected()];
  const activeDescendant = () => {
    const action = activeAction();
    const buffer = activeBuffer();
    return mode() === "commands"
      ? action === undefined
        ? undefined
        : actionOptionId(action)
      : buffer === undefined
        ? undefined
        : optionId(buffer.buffer.id);
  };

  createEffect(() => {
    const count = resultCount();
    if (count === 0) setSelected(0);
    else if (selected() >= count) setSelected(count - 1);
  });
  createEffect(() => {
    const id = activeDescendant();
    if (id === undefined) return;
    queueMicrotask(() =>
      document.getElementById(id)?.scrollIntoView?.({ block: "nearest" }),
    );
  });

  const open = (item: SwitcherBuffer | undefined) => {
    if (item === undefined) return;
    restoreInvoker = false;
    props.onOpen(item.buffer.id);
  };
  const run = (item: ActionEntry | undefined) => {
    if (item === undefined || !props.onRunAction(item.id)) return;
    restoreInvoker = false;
    props.onDismiss();
  };
  const keydown = (event: KeyboardEvent) => {
    const intent = switcherKeyIntent(event);
    if (intent === undefined) return false;
    event.preventDefault();
    event.stopPropagation();
    if (intent === "dismiss") props.onDismiss();
    else if (intent === "open")
      mode() === "commands" ? run(activeAction()) : open(activeBuffer());
    else
      setSelected((current) =>
        moveSwitcherSelection(
          current,
          resultCount(),
          intent === "next" ? 1 : -1,
        ),
      );
    return true;
  };

  return (
    <OmnibarOverlay
      activeDescendant={activeDescendant()}
      closeLabel={
        mode() === "commands" ? t("palette.close") : t("switcher.close")
      }
      escapeHint={t("switcher.escape")}
      inputLabel={
        mode() === "commands" ? t("palette.input") : t("switcher.input")
      }
      label={mode() === "commands" ? t("palette.dialog") : t("switcher.dialog")}
      listboxId={listboxId}
      onDismiss={props.onDismiss}
      onInput={(value) => {
        setQuery(value);
        setSelected(0);
      }}
      onKeyDown={keydown}
      placeholder={
        mode() === "commands"
          ? t("palette.placeholder")
          : t("switcher.placeholder")
      }
      query={query()}
      shouldRestoreFocus={() => restoreInvoker}
    >
      <div
        aria-label={
          mode() === "commands" ? t("palette.results") : t("switcher.results")
        }
        class={styles.results}
        id={listboxId}
        role="listbox"
      >
        <Show when={mode() === "buffers"}>
          <For each={bufferResults()}>
            {(item, index) => {
              const badge = () => unreadBadge(item.buffer);
              return (
                <OmnibarRow
                  aria-label={optionLabel(item, badge()?.label)}
                  aria-selected={index() === selected()}
                  data-buffer-id={item.buffer.id}
                  id={optionId(item.buffer.id)}
                  label={displayTitle(item.buffer)}
                  leading={item.buffer.kind === "channel" ? "#" : "@"}
                  onClick={() => open(item)}
                  trailing={
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
                  }
                  suffix={item.network}
                />
              );
            }}
          </For>
        </Show>
        <Show when={mode() === "commands"}>
          <For each={actionResults()}>
            {(action, index) => (
              <OmnibarRow
                aria-keyshortcuts={action.shortcut?.ariaKeyShortcuts}
                aria-selected={index() === selected()}
                id={actionOptionId(action)}
                label={action.title}
                leading=">"
                onClick={() => run(action)}
                trailing={
                  <Show when={action.shortcut} keyed>
                    {(shortcut) => (
                      <kbd class={styles.chord}>{shortcut.labels[0]}</kbd>
                    )}
                  </Show>
                }
                suffix={action.group}
                title={action.shortcut?.labels.join(" / ")}
              />
            )}
          </For>
        </Show>
        <Show when={resultCount() === 0}>
          <p class={styles.empty}>
            {mode() === "commands" ? t("palette.empty") : t("switcher.empty")}
          </p>
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
