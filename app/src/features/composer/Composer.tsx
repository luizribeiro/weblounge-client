import { createEffect, createSignal, For, type JSX } from "solid-js";
import type { CommandSpec } from "../../engine/protocol";
import styles from "../conversation/SimpleComposer.module.css";
import { commandForInput } from "./command-input";
import { readDraft, removeDraft, writeDraft } from "./draft-storage";
import { isSecretInput } from "./secret-input";

interface ComposerProps {
  readonly bufferId: number;
  readonly draftKey: string;
  readonly bufferTitle: string;
  readonly commandSpecs?: readonly CommandSpec[] | undefined;
  readonly candidatePrefix?: string | undefined;
  readonly candidates?: readonly string[] | undefined;
  readonly disabled?: boolean;
  readonly onRequestCandidates?: (prefix: string) => void;
  readonly onSelectLast?: () => void;
  readonly onSend: (text: string) => boolean | void | Promise<boolean | void>;
}

export function Composer(props: ComposerProps) {
  let textarea: HTMLTextAreaElement | undefined;
  let confirmButton: HTMLButtonElement | undefined;
  let completion:
    | { start: number; end: number; candidates: readonly string[] }
    | undefined;
  const [pendingCompletion, setPendingCompletion] = createSignal<
    { start: number; end: number; prefix: string; offset: number } | undefined
  >();
  let currentBuffer = props.bufferId;
  let currentDraftKey = props.draftKey;
  const [text, setText] = createSignal(readDraft(currentDraftKey));
  const [selected, setSelected] = createSignal(-1);
  const [shownCandidates, setShownCandidates] = createSignal<readonly string[]>(
    [],
  );
  const [pendingConfirmation, setPendingConfirmation] =
    createSignal<CommandSpec>();
  const listId = () => `composer-completions-${props.bufferId}`;
  const optionId = (index: number) => `${listId()}-${index}`;
  const resize = () => {
    if (textarea === undefined) return;
    textarea.style.height = "0";
    textarea.style.height = `${textarea.scrollHeight}px`;
  };

  createEffect(() => {
    const value = text();
    const specs = props.commandSpecs;
    if (specs === undefined || isSecretInput(value, specs)) {
      removeDraft(currentDraftKey);
    } else {
      writeDraft(currentDraftKey, value);
    }
    queueMicrotask(resize);
  });

  createEffect(() => {
    if (props.bufferId === currentBuffer) return;
    currentBuffer = props.bufferId;
    currentDraftKey = props.draftKey;
    setText(readDraft(currentDraftKey));
    completion = undefined;
    setPendingCompletion(undefined);
    setSelected(-1);
    setShownCandidates([]);
    setPendingConfirmation(undefined);
  });

  const update = (value: string, resetCompletion = true) => {
    setText(value);
    setPendingConfirmation(undefined);
    if (resetCompletion) {
      completion = undefined;
      setPendingCompletion(undefined);
      setSelected(-1);
      setShownCandidates([]);
    }
  };
  const submit = (confirmed = false) => {
    const submitted = text();
    const submittedBuffer = currentBuffer;
    const submittedDraftKey = currentDraftKey;
    if (submitted.trim() === "") return;
    const command = commandForInput(submitted, props.commandSpecs ?? []);
    if (!confirmed && command?.confirm === "always") {
      setPendingConfirmation(command);
      queueMicrotask(() => confirmButton?.focus());
      return;
    }
    setPendingConfirmation(undefined);
    void Promise.resolve(props.onSend(submitted))
      .then((accepted) => {
        if (accepted === false) return;
        if (readDraft(submittedDraftKey) === submitted) {
          removeDraft(submittedDraftKey);
        }
        if (currentBuffer === submittedBuffer && text() === submitted) {
          setText("");
          setSelected(-1);
        }
      })
      .catch(() => undefined);
  };
  const complete = (offset: number) => {
    if (completion === undefined) {
      const end = textarea?.selectionStart ?? text().length;
      const start = text().slice(0, end).search(/\S*$/);
      const prefix = text().slice(start, end);
      if (
        props.onRequestCandidates !== undefined &&
        props.candidatePrefix !== prefix
      ) {
        setPendingCompletion({ start, end, prefix, offset });
        props.onRequestCandidates(prefix);
        return true;
      }
      completion = {
        start,
        end,
        candidates: props.candidates ?? [],
      };
      setShownCandidates(completion.candidates);
    }
    if (completion.candidates.length === 0) return false;
    const next =
      (selected() + offset + completion.candidates.length) %
      completion.candidates.length;
    setSelected(next);
    const candidate = completion.candidates[next] ?? "";
    update(
      `${text().slice(0, completion.start)}${candidate} ${text().slice(completion.end)}`,
      false,
    );
    completion.end = completion.start + candidate.length + 1;
    queueMicrotask(() =>
      textarea?.setSelectionRange(completion?.end ?? 0, completion?.end ?? 0),
    );
    return true;
  };
  createEffect(() => {
    const prefix = props.candidatePrefix;
    const candidates = props.candidates;
    const pending = pendingCompletion();
    if (pending === undefined || prefix !== pending.prefix) return;
    completion = {
      start: pending.start,
      end: pending.end,
      candidates: candidates ?? [],
    };
    setShownCandidates(completion.candidates);
    setPendingCompletion(undefined);
    complete(pending.offset);
  });
  const keydown: JSX.EventHandler<HTMLTextAreaElement, KeyboardEvent> = (
    event,
  ) => {
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      event.key === "Dead" ||
      event.key === "Process"
    )
      return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === "Tab" && complete(event.shiftKey ? -1 : 1)) {
      event.preventDefault();
    } else if (event.key === "ArrowUp" && text() === "") {
      props.onSelectLast?.();
    }
  };

  return (
    <div class={styles.wrap}>
      {shownCandidates().length > 0 && selected() >= 0 && (
        <div class={styles.candidates} id={listId()} role="listbox">
          <For each={shownCandidates()}>
            {(candidate, index) => (
              <div
                aria-selected={index() === selected()}
                class={styles.candidate}
                data-selected={index() === selected()}
                id={optionId(index())}
                role="option"
                tabIndex={-1}
              >
                {candidate}
              </div>
            )}
          </For>
        </div>
      )}
      {pendingConfirmation() !== undefined && (
        <div
          aria-label={`Confirm /${pendingConfirmation()?.name}`}
          class={styles.confirmation}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            setPendingConfirmation(undefined);
            queueMicrotask(() => textarea?.focus());
          }}
          role="alertdialog"
        >
          <span>Run /{pendingConfirmation()?.name}?</span>
          <button
            class={styles.confirm}
            onClick={() => submit(true)}
            ref={confirmButton}
            type="button"
          >
            Confirm
          </button>
          <button
            class={styles.cancel}
            onClick={() => {
              setPendingConfirmation(undefined);
              textarea?.focus();
            }}
            type="button"
          >
            Cancel
          </button>
        </div>
      )}
      <div class={styles.form}>
        <textarea
          aria-activedescendant={
            selected() >= 0 ? optionId(selected()) : undefined
          }
          aria-controls={shownCandidates().length > 0 ? listId() : undefined}
          aria-label={`Message ${props.bufferTitle}`}
          autocomplete="off"
          class={styles.input}
          disabled={props.disabled}
          onCompositionStart={() => update(text())}
          onInput={(event) => update(event.currentTarget.value)}
          onKeyDown={keydown}
          placeholder={`Message ${props.bufferTitle}`}
          ref={textarea}
          rows={1}
          value={text()}
        />
        <button
          class={styles.send}
          disabled={props.disabled}
          onClick={() => submit()}
          type="button"
        >
          Send
        </button>
      </div>
    </div>
  );
}
