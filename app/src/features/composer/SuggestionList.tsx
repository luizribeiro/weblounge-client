import { createMemo, For, onCleanup } from "solid-js";
import type { CompletionCandidate } from "../../engine/protocol";
import { TouchTapGesture } from "../../platform/focus-without-pan";
import { nickPaletteSize } from "../../theme/theme-registry";
import { Line } from "../../ui/Line";
import styles from "../conversation/SimpleComposer.module.css";
import { t, translate } from "./strings";

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
      {props.hint !== null && (
        <Line class={styles.hint}>{translate(props.hint)}</Line>
      )}
      <div class={styles.candidates} id={props.listId} role="listbox">
        <For each={candidateIds()}>
          {(id, index) => {
            const candidate = () => candidateById(id);
            const touchTap = new TouchTapGesture();
            let acceptedByTouch = false;
            return (
              <div
                aria-selected={index() === props.selected}
                class={styles.candidate}
                data-selected={index() === props.selected}
                id={props.optionId(index())}
                onClick={() => {
                  if (acceptedByTouch) {
                    acceptedByTouch = false;
                    return;
                  }
                  props.onAccept(index());
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    props.onAccept(index());
                  }
                }}
                onMouseEnter={() => props.onSelect(index())}
                onPointerCancel={(event) => {
                  if (event.pointerType === "touch") touchTap.cancel();
                }}
                onPointerDown={(event) => {
                  event.preventDefault();
                  if (event.pointerType === "touch")
                    touchTap.begin(pointerTouch(event), event.timeStamp);
                }}
                onPointerMove={(event) => {
                  if (event.pointerType === "touch")
                    touchTap.move(pointerTouch(event));
                }}
                onPointerUp={(event) => {
                  if (
                    event.pointerType !== "touch" ||
                    !touchTap.end(pointerTouch(event), event.timeStamp).accepted
                  )
                    return;
                  acceptedByTouch = true;
                  props.onAccept(index());
                }}
                ref={preventTouchFocus}
                role="option"
                tabIndex={-1}
              >
                <Line class={styles.primary}>
                  <span style={candidateStyle(candidate())}>
                    {candidateLabel(candidate())}
                  </span>
                  {candidateIsBot(candidate()) && (
                    <span class={styles.bot}>{t("common.bot")}</span>
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

function preventTouchFocus(element: HTMLElement): void {
  // WebKit treats delegated document touch listeners as passive, so this row
  // must own the cancellable listener that keeps focus on the composer.
  const prevent = (event: TouchEvent) => event.preventDefault();
  element.addEventListener("touchstart", prevent, { passive: false });
  onCleanup(() => element.removeEventListener("touchstart", prevent));
}

function pointerTouch(event: PointerEvent) {
  return {
    clientX: event.clientX,
    clientY: event.clientY,
    identifier: event.pointerId,
  };
}

function candidateIsBot(candidate: CompletionCandidate | undefined): boolean {
  return candidate?.type === "person" && candidate.bot === true;
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
      const usage = translate(candidate.usage);
      const argumentsOnly = usage.startsWith(invocation)
        ? usage.slice(invocation.length).trimStart()
        : usage;
      return argumentsOnly === ""
        ? translate(candidate.description)
        : `${argumentsOnly} · ${translate(candidate.description)}`;
    }
    case "person":
      return candidate.away ? t("common.away") : null;
    case "channel":
      return t("common.channel");
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
