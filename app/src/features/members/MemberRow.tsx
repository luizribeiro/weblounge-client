import type { EngineToUi } from "../../engine/protocol";
import { nickPaletteSize } from "../../theme/theme-registry";
import { Line } from "../../ui/Line";
import styles from "./MemberRow.module.css";

export type Member = Extract<
  EngineToUi,
  { type: "members_changed" }
>["members"][number];

interface MemberRowProps {
  readonly member: Member;
  readonly onOpenDirect: (nick: string) => void;
  readonly hidden?: boolean | undefined;
  readonly showModeSymbol?: boolean | undefined;
}

export function MemberRow(props: MemberRowProps) {
  const color = () =>
    props.member.is_you
      ? "var(--wl-color-self-nick)"
      : `var(--wl-nick-${props.member.nick_color_index % nickPaletteSize})`;
  return (
    <button
      aria-label={`Open direct message with ${props.member.nick}`}
      class={styles.row}
      data-away={props.member.away ? "true" : "false"}
      hidden={props.hidden}
      onClick={() => props.onOpenDirect(props.member.nick)}
      type="button"
    >
      <span
        aria-hidden="true"
        class={styles.avatar}
        style={{ background: color() }}
      >
        {initial(props.member.nick)}
      </span>
      <Line class={styles.identity} title={props.member.nick}>
        {props.showModeSymbol !== false && (
          <span class={styles.mode}>{props.member.mode_symbol ?? ""}</span>
        )}
        <span class={styles.nick} style={{ color: color() }}>
          {props.member.nick}
        </span>
      </Line>
      {props.member.bot && <span class={styles.bot}>BOT</span>}
      {props.member.is_you && <span class={styles.you}>you</span>}
    </button>
  );
}

function initial(nick: string): string {
  return Array.from(nick)[0]?.toLocaleUpperCase() ?? "?";
}
