import { createVirtualizer, observeElementRect } from "@tanstack/solid-virtual";
import { createEffect, createMemo, For } from "solid-js";
import type { EngineToUi } from "../../engine/protocol";
import styles from "./MemberPanel.module.css";
import { MemberRow } from "./MemberRow";
import {
  type MemberListRow,
  memberGroupLabels,
  memberRowAt,
  memberRowCount,
} from "./member-rows";

export type MemberWindow = Extract<EngineToUi, { type: "members_changed" }>;
interface MemberPanelProps {
  readonly bufferTitle: string;
  readonly filter?: string | undefined;
  readonly window: MemberWindow | undefined;
  readonly onClose: () => void;
  readonly onFilter?: ((filter: string) => void) | undefined;
  readonly onOpenDirect: (nick: string) => void;
  readonly onRequestRange: (offset: number, limit: number) => void;
  readonly showModeSymbols?: boolean | undefined;
}

export function MemberPanel(props: MemberPanelProps) {
  let list: HTMLUListElement | undefined;
  let requested = "";
  const window = () =>
    (props.window?.filter ?? "") === (props.filter ?? "")
      ? props.window
      : undefined;
  const counts = () => window()?.counts ?? [0, 0, 0, 0, 0];
  const virtualizer = createVirtualizer<HTMLUListElement, HTMLLIElement>({
    get count() {
      return memberRowCount(counts());
    },
    getScrollElement: () => list ?? null,
    initialRect: { width: 216, height: 600 },
    observeElementRect: (instance, callback) =>
      observeElementRect(instance, (rect) =>
        callback(rect.height === 0 ? { width: 216, height: 600 } : rect),
      ),
    estimateSize: (index) =>
      memberRowAt(index, counts(), 0, [])?.kind === "group" ? 28 : 24,
    overscan: 10,
  });
  const virtualRows = createMemo(() => virtualizer.getVirtualItems());
  const request = (offset: number) => {
    const key = `${window()?.buffer_id ?? "new"}:${props.filter ?? ""}:${offset}`;
    if (key !== requested) {
      requested = key;
      props.onRequestRange(offset, 256);
    }
  };
  createEffect(() => {
    const current = window();
    if (current === undefined) return request(0);
    const missing = virtualRows()
      .map((item) =>
        memberRowAt(
          item.index,
          current.counts,
          current.offset,
          current.members,
        ),
      )
      .find((row) => row?.kind === "member" && row.member === undefined);
    if (missing?.kind === "member")
      request(Math.floor(missing.memberIndex / 128) * 128);
  });
  return (
    <aside aria-label="Members" class={styles.panel}>
      <header class={styles.header}>
        <span class={styles.title}>Members</span>
        <span class={styles.total}>{formatCount(window()?.total ?? 0)}</span>
        <button
          aria-label="Hide members"
          class={styles.close}
          onClick={props.onClose}
          type="button"
        >
          ×
        </button>
      </header>
      <div class={styles.content} data-member-buffer={props.bufferTitle}>
        {props.onFilter !== undefined ? (
          <label class={styles.filter}>
            <span class="visually-hidden">Filter members</span>
            <span aria-hidden="true">⌕</span>
            <input
              autofocus
              onInput={(event) => props.onFilter?.(event.currentTarget.value)}
              placeholder="Filter members"
              type="search"
              value={props.filter ?? ""}
            />
          </label>
        ) : (
          <div class={styles.following}>
            Following <strong>{props.bufferTitle}</strong>
          </div>
        )}
        <ul
          aria-label={`Members of ${props.bufferTitle}`}
          class={styles.list}
          ref={list}
        >
          <div
            aria-hidden="true"
            class={styles.spacer}
            data-member-virtual-size="true"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          />
          <For each={virtualRows()}>
            {(virtualRow) => (
              <li
                class={styles.virtualRow}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderRow(
                  window() === undefined
                    ? undefined
                    : memberRowAt(
                        virtualRow.index,
                        window()?.counts ?? [0, 0, 0, 0, 0],
                        window()?.offset ?? 0,
                        window()?.members ?? [],
                      ),
                  props.onOpenDirect,
                  props.showModeSymbols !== false,
                )}
              </li>
            )}
          </For>
        </ul>
      </div>
    </aside>
  );
}

function renderRow(
  row: MemberListRow | undefined,
  onOpenDirect: (nick: string) => void,
  showModeSymbols: boolean,
) {
  if (row?.kind === "group")
    return (
      <div class={styles.group}>
        {memberGroupLabels[row.group]} — {formatCount(row.count)}
      </div>
    );
  if (row?.kind === "member" && row.member !== undefined)
    return (
      <MemberRow
        member={row.member}
        onOpenDirect={onOpenDirect}
        showModeSymbol={showModeSymbols}
      />
    );
  return <div class={styles.placeholder} />;
}
function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}
