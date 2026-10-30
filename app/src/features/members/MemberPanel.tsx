import { createVirtualizer, observeElementRect } from "@tanstack/solid-virtual";
import { createMemo, createRenderEffect, Index } from "solid-js";
import {
  type DensityId,
  densityDefaults,
  densityPresets,
} from "../../density/density";
import type { EngineToUi } from "../../engine/protocol";
import styles from "./MemberPanel.module.css";
import { type Member, MemberRow } from "./MemberRow";
import {
  type MemberListRow,
  memberGroupLabels,
  memberRowAt,
  memberRowCount,
} from "./member-rows";

type MemberWindowEvent = Extract<EngineToUi, { type: "members_changed" }>;
export type MemberWindow = MemberWindowEvent & {
  readonly view_id: string;
  readonly version: number;
  readonly window_size: number;
};
interface MemberPanelProps {
  readonly autofocusFilter?: boolean | undefined;
  readonly bufferTitle: string;
  readonly closeLabel?: string | undefined;
  readonly filter?: string | undefined;
  readonly window: MemberWindow | undefined;
  readonly onClose: () => void;
  readonly onFilter?: ((filter: string) => void) | undefined;
  readonly onOpenDirect: (nick: string) => void;
  readonly onRequestRange: (offset: number) => void;
  readonly showModeSymbols?: boolean | undefined;
  readonly presentation?: "desktop" | "mobile" | undefined;
}

export function MemberPanel(props: MemberPanelProps) {
  const metrics = memberPanelMetrics(props.presentation ?? "desktop");
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
      memberRowAt(index, counts(), 0, [])?.kind === "group"
        ? metrics.group
        : metrics.member,
    overscan: 10,
  });
  const virtualRows = createMemo(() => virtualizer.getVirtualItems());
  const renderedRows = createMemo(() => {
    const current = window();
    return virtualRows().map((virtual) => ({
      virtual,
      row:
        current === undefined
          ? undefined
          : memberRowAt(
              virtual.index,
              current.counts,
              current.offset,
              current.members,
            ),
    }));
  });
  const request = (offset: number) => {
    const current = window();
    const key = `${current?.view_id ?? "new"}:${current?.version ?? "new"}:${props.filter ?? ""}:${offset}`;
    if (key !== requested) {
      requested = key;
      props.onRequestRange(offset);
    }
  };
  createRenderEffect(() => {
    const current = window();
    if (current === undefined) return request(0);
    const missing = renderedRows()
      .map(({ row }) => row)
      .find((row) => row?.kind === "member" && row.member === undefined);
    if (missing?.kind === "member") {
      const stride = Math.max(1, Math.floor(current.window_size / 2));
      request(Math.floor(missing.memberIndex / stride) * stride);
    }
  });
  return (
    <aside
      aria-label="Members"
      class={styles.panel}
      style={{
        "--wl-member-group-row-height": `${metrics.group}px`,
        "--wl-density-sidebar-member-row-height": `${metrics.member}px`,
      }}
    >
      <header class={styles.header}>
        <span class={styles.title}>Members</span>
        <span class={styles.total}>{formatCount(window()?.total ?? 0)}</span>
        <button
          aria-label={props.closeLabel ?? "Hide members"}
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
              autofocus={props.autofocusFilter !== false}
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
          <Index each={renderedRows()}>
            {(rendered) => (
              <li
                class={styles.virtualRow}
                style={{
                  transform: `translateY(${rendered().virtual.start}px)`,
                }}
              >
                <MemberListRowView
                  onOpenDirect={props.onOpenDirect}
                  row={rendered().row}
                  showModeSymbols={props.showModeSymbols !== false}
                />
              </li>
            )}
          </Index>
        </ul>
      </div>
    </aside>
  );
}

function memberPanelMetrics(presentation: "desktop" | "mobile") {
  const attribute =
    presentation === "mobile" ? "mobileDensity" : "sidebarDensity";
  const fallback =
    presentation === "mobile"
      ? densityDefaults.mobileList
      : densityDefaults.desktopList;
  const selected = document.documentElement.dataset[attribute];
  const density: DensityId = isDensityId(selected) ? selected : fallback;
  const member = Number.parseFloat(densityPresets[density].memberRowHeight);
  return {
    group: 28,
    member: presentation === "mobile" ? Math.max(44, member) : member,
  };
}

function isDensityId(value: string | undefined): value is DensityId {
  return value === "compact" || value === "cozy" || value === "comfortable";
}

function MemberListRowView(props: {
  readonly row: MemberListRow | undefined;
  readonly onOpenDirect: (nick: string) => void;
  readonly showModeSymbols: boolean;
}) {
  const member = () =>
    props.row?.kind === "member" ? props.row.member : undefined;
  const retainedMember = createMemo<Member>(
    (previous) => member() ?? previous,
    loadingMember,
  );
  return (
    <>
      <div class={styles.group} hidden={props.row?.kind !== "group"}>
        {props.row?.kind === "group"
          ? `${memberGroupLabels[props.row.group]} — ${formatCount(props.row.count)}`
          : ""}
      </div>
      <MemberRow
        hidden={member() === undefined}
        member={retainedMember()}
        onOpenDirect={props.onOpenDirect}
        showModeSymbol={props.showModeSymbols}
      />
    </>
  );
}

const loadingMember: Member = {
  group: "online",
  nick: "",
  mode_symbol: null,
  away: false,
  bot: false,
  account: null,
  nick_color_index: 0,
  is_you: false,
};
function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}
