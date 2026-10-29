import { For } from "solid-js";
import type { CompletionCandidate } from "../../engine/protocol";
import { nickPaletteSize } from "../../theme/theme-registry";
import { Line } from "../../ui/Line";
import styles from "../conversation/SimpleComposer.module.css";
import { t } from "./strings";

interface SuggestionListProps {
  readonly candidates: readonly CompletionCandidate[];
  readonly hint: string | null;
  readonly listId: string;
  readonly optionId: (index: number) => string;
  readonly selected: number;
  readonly onAccept: (index: number) => void;
  readonly onSelect: (index: number) => void;
}

export function SuggestionList(props: SuggestionListProps) {
  return (
    <div class={styles.popup} data-composer-suggestions="true">
      {props.hint !== null && <Line class={styles.hint}>{t(props.hint)}</Line>}
      <div class={styles.candidates} id={props.listId} role="listbox">
        <For each={props.candidates}>
          {(candidate, index) => (
            <div
              aria-selected={index() === props.selected}
              class={styles.candidate}
              data-selected={index() === props.selected}
              id={props.optionId(index())}
              onClick={() => props.onAccept(index())}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  props.onAccept(index());
                }
              }}
              onMouseEnter={() => props.onSelect(index())}
              onPointerDown={(event) => {
                if (event.pointerType === "mouse") event.preventDefault();
              }}
              role="option"
              tabIndex={-1}
            >
              <Line class={styles.primary}>
                <span style={candidateStyle(candidate)}>
                  {candidateLabel(candidate)}
                </span>
                {candidate.type === "person" && candidate.bot && (
                  <span class={styles.bot}>BOT</span>
                )}
              </Line>
              <Line class={styles.secondary}>{candidateDetail(candidate)}</Line>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

function candidateLabel(candidate: CompletionCandidate): string {
  switch (candidate.type) {
    case "command":
      return `/${candidate.name}`;
    case "person":
      return candidate.nick;
    case "channel":
      return candidate.name;
  }
}

function candidateDetail(candidate: CompletionCandidate): string {
  switch (candidate.type) {
    case "command":
      return `${t(candidate.usage)} · ${t(candidate.description)}`;
    case "person":
      return candidate.away ? "Away" : candidate.bot ? "Bot" : "Member";
    case "channel":
      return "Channel";
  }
}

function candidateStyle(candidate: CompletionCandidate) {
  return candidate.type === "person"
    ? {
        color: `var(--wl-nick-${candidate.nick_color_index % nickPaletteSize})`,
        opacity: candidate.away ? 0.62 : 1,
      }
    : undefined;
}
