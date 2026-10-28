import { createEffect, For } from "solid-js";
import type { EngineToUi } from "../../engine/protocol";
import styles from "./MemberPanel.module.css";
import { MemberRow } from "./MemberRow";
import { memberGroupLabels, memberGroups } from "./member-rows";

export type MemberWindow = Extract<EngineToUi, { type: "members_changed" }>;

interface MemberPanelProps {
  readonly bufferTitle: string;
  readonly window: MemberWindow | undefined;
  readonly onClose: () => void;
  readonly onOpenDirect: (nick: string) => void;
  readonly onRequestRange: (offset: number, limit: number) => void;
}

export function MemberPanel(props: MemberPanelProps) {
  createEffect(() => {
    if (props.window === undefined) props.onRequestRange(0, 128);
  });
  return (
    <aside aria-label="Members" class={styles.panel}>
      <header class={styles.header}>
        <span class={styles.title}>Members</span>
        <span class={styles.total}>
          {formatCount(props.window?.total ?? 0)}
        </span>
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
        <div class={styles.following}>
          Following <strong>{props.bufferTitle}</strong>
        </div>
        <ul aria-label={`Members of ${props.bufferTitle}`} class={styles.list}>
          <For each={memberGroups}>
            {(group, index) => (
              <>
                {(props.window?.counts[index()] ?? 0) > 0 && (
                  <li class={styles.group}>
                    {memberGroupLabels[group]} —{" "}
                    {formatCount(props.window?.counts[index()] ?? 0)}
                  </li>
                )}
                <For
                  each={props.window?.members.filter(
                    (member) => member.group === group,
                  )}
                >
                  {(member) => (
                    <li>
                      <MemberRow
                        member={member}
                        onOpenDirect={props.onOpenDirect}
                      />
                    </li>
                  )}
                </For>
              </>
            )}
          </For>
        </ul>
      </div>
    </aside>
  );
}

function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}
