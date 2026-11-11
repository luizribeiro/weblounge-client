import { createMemo, For, Match, Switch } from "solid-js";
import type { SystemProjection } from "../../../engine/generated/SystemProjection";
import { formatTime } from "../../../ui/format-time";
import { EventIcon } from "../../../ui/icons/EventIcon";
import { nickColor } from "../nick-color";
import styles from "./SystemLine.module.css";
import {
  type SystemLineAction,
  type SystemLineSegment,
  systemLineText,
  systemLineWords,
} from "./system-line-words";

export function SystemLine(props: {
  readonly canRejoin: boolean;
  readonly expanded: boolean;
  readonly onAction: (action: SystemLineAction) => void;
  readonly presentation: "desktop" | "mobile";
  readonly system: SystemProjection;
}) {
  const words = createMemo(() =>
    systemLineWords(props.system.line, {
      canRejoin: props.canRejoin,
      expanded: props.expanded,
      includeRawModes: props.presentation === "desktop",
    }),
  );
  const accessibleName = () =>
    [words().segments, ...words().details]
      .map(systemLineText)
      .filter(Boolean)
      .join(". ");

  return (
    <section
      aria-label={accessibleName()}
      class={styles.line}
      data-expanded={props.expanded}
      data-presentation={props.presentation}
      data-system-line="true"
      data-warning={words().warning}
    >
      <time
        class={styles.time}
        dateTime={new Date(props.system.time_ms).toISOString()}
      >
        {formatTime(props.system.time_ms)}
      </time>
      <span class={styles.iconColumn}>
        <EventIcon
          class={styles.icon}
          icon={words().icon}
          label={words().warning ? "Warning" : undefined}
        />
      </span>
      <div class={styles.content}>
        <div data-system-summary="true">
          <Segments onAction={props.onAction} segments={words().segments} />
        </div>
        <For each={words().details}>
          {(segments) => (
            <div class={styles.detail} data-system-detail="true">
              <Segments onAction={props.onAction} segments={segments} />
            </div>
          )}
        </For>
      </div>
    </section>
  );
}

function Segments(props: {
  readonly onAction: (action: SystemLineAction) => void;
  readonly segments: readonly SystemLineSegment[];
}) {
  return (
    <For each={props.segments}>
      {(segment) => (
        <Switch>
          <Match when={segment.kind === "text"}>{segment.text}</Match>
          <Match when={segment.kind === "mono"}>
            {segment.kind === "mono" && (
              <span class={styles.mono}>{segment.text}</span>
            )}
          </Match>
          <Match when={segment.kind === "nick"}>
            {segment.kind === "nick" && (
              <span
                class={styles.nick}
                data-own={segment.person.me}
                style={{
                  color: segment.person.me
                    ? "var(--wl-color-self-nick)"
                    : nickColor(segment.person.nick_color_index),
                }}
              >
                {segment.text}
              </span>
            )}
          </Match>
          <Match when={segment.kind === "button"}>
            {segment.kind === "button" && (
              <button
                aria-expanded={
                  segment.action === "expand"
                    ? false
                    : segment.action === "collapse"
                      ? true
                      : undefined
                }
                aria-label={segment.accessibleName}
                class={styles.action}
                onClick={() => props.onAction(segment.action)}
                type="button"
              >
                {segment.text}
              </button>
            )}
          </Match>
        </Switch>
      )}
    </For>
  );
}
