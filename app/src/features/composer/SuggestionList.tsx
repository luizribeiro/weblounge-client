import { createMemo, For } from "solid-js";
import type { CompletionCandidate } from "../../engine/protocol";
import { nickPaletteSize } from "../../theme/theme-registry";
import { Line } from "../../ui/Line";
import styles from "../conversation/SimpleComposer.module.css";
import { t } from "./strings";

interface SuggestionListProps {
  readonly candidates: readonly CompletionCandidate[];
  readonly completionInput: string;
  readonly hint: string | null;
  readonly listId: string;
  readonly optionId: (index: number) => string;
  readonly selected: number;
  readonly onAccept: (index: number) => void;
  readonly onSelect: (index: number) => void;
}

export function SuggestionList(props: SuggestionListProps) {
  const candidateIds = createMemo(() => props.candidates.map(candidateId));
  const candidateById = (id: string) =>
    props.candidates.find((candidate) => candidateId(candidate) === id);
  return (
    <div
      class={styles.popup}
      data-completion-input={props.completionInput}
      data-composer-suggestions="true"
    >
      {props.hint !== null && <Line class={styles.hint}>{t(props.hint)}</Line>}
      <div class={styles.candidates} id={props.listId} role="listbox">
        <For each={candidateIds()}>
          {(id, index) => {
            const candidate = () => candidateById(id);
            return (
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
                onPointerDown={(event) => event.preventDefault()}
                role="option"
                tabIndex={-1}
              >
                <Line class={styles.primary}>
                  <span style={candidateStyle(candidate())}>
                    {candidateLabel(candidate())}
                  </span>
                  {candidateIsBot(candidate()) && (
                    <span class={styles.bot}>BOT</span>
                  )}
                </Line>
                {candidateDetail(candidate()) !== null && (
                  <Line class={styles.secondary}>
                    {candidateDetail(candidate())}
                  </Line>
                )}
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}

function candidateIsBot(candidate: CompletionCandidate | undefined): boolean {
  return candidate?.type === "person" && candidate.bot;
}

function candidateId(candidate: CompletionCandidate): string {
  switch (candidate.type) {
    case "command":
      return `command:${candidate.name}`;
    case "person":
      return `person:${candidate.nick}`;
    case "channel":
      return `channel:${candidate.name}`;
  }
}

function candidateLabel(candidate: CompletionCandidate | undefined): string {
  if (candidate === undefined) return "";
  switch (candidate.type) {
    case "command":
      return `/${candidate.name}`;
    case "person":
      return candidate.nick;
    case "channel":
      return candidate.name;
  }
}

function candidateDetail(
  candidate: CompletionCandidate | undefined,
): string | null {
  if (candidate === undefined) return null;
  switch (candidate.type) {
    case "command": {
      const invocation = `/${candidate.name}`;
      const usage = t(candidate.usage);
      const argumentsOnly = usage.startsWith(invocation)
        ? usage.slice(invocation.length).trimStart()
        : usage;
      return argumentsOnly === ""
        ? t(candidate.description)
        : `${argumentsOnly} · ${t(candidate.description)}`;
    }
    case "person":
      return candidate.away ? "Away" : null;
    case "channel":
      return "Channel";
  }
}

function candidateStyle(candidate: CompletionCandidate | undefined) {
  return candidate?.type === "person"
    ? {
        color: `var(--wl-nick-${candidate.nick_color_index % nickPaletteSize})`,
        opacity: candidate.away ? 0.62 : 1,
      }
    : undefined;
}
