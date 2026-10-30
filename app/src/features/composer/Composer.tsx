import { createEffect, createMemo, createSignal, type JSX } from "solid-js";
import type {
  CommandSpec,
  CompletionCandidate,
  CompletionResult,
} from "../../engine/protocol";
import { platformEnvironment } from "../../platform/environment";
import styles from "../conversation/SimpleComposer.module.css";
import { commandForInput } from "./command-input";
import { readDraft, removeDraft, writeDraft } from "./draft-storage";
import { SuggestionList } from "./SuggestionList";
import { isSecretInput } from "./secret-input";
import { t } from "./strings";

interface ComposerProps {
  readonly bufferId: number;
  readonly draftKey: string;
  readonly bufferTitle: string;
  readonly commandSpecs?: readonly CommandSpec[] | undefined;
  readonly completion?: CompletionResult | undefined;
  readonly disabled?: boolean;
  readonly onRequestCandidates?: (
    input: string,
    cursor: number,
    explicit: boolean,
  ) => void;
  readonly onSelectLast?: () => void;
  readonly onSend: (
    text: string,
  ) => boolean | undefined | Promise<boolean | undefined>;
}

export function Composer(props: ComposerProps) {
  const platform = platformEnvironment();
  let textarea: HTMLTextAreaElement | undefined;
  let confirmButton: HTMLButtonElement | undefined;
  let composing = false;
  let pendingTabInput: string | undefined;
  let currentBuffer = props.bufferId;
  let currentDraftKey = props.draftKey;
  const [text, setText] = createSignal(readDraft(currentDraftKey));
  const [selected, setSelected] = createSignal(-1);
  const [completionCursor, setCompletionCursor] = createSignal(text().length);
  const [dismissedInput, setDismissedInput] = createSignal<string>();
  const [pendingConfirmation, setPendingConfirmation] =
    createSignal<CommandSpec>();
  const listId = () => `composer-completions-${props.bufferId}`;
  const optionId = (index: number) => `${listId()}-${index}`;
  const suggestions = createMemo(() => {
    const result = props.completion;
    return result?.buffer_id === props.bufferId &&
      text() !== dismissedInput() &&
      result.candidates.length > 0
      ? result
      : undefined;
  });
  const confirmationText = () => {
    const command = pendingConfirmation();
    const prompt = command?.confirmation_prompt;
    return prompt === undefined ? "" : t(prompt, { text: props.bufferTitle });
  };
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
    setSelected(-1);
    setDismissedInput(undefined);
    setPendingConfirmation(undefined);
  });

  const update = (value: string) => {
    setText(value);
    setPendingConfirmation(undefined);
    setSelected(-1);
    if (dismissedInput() !== value) setDismissedInput(undefined);
  };
  const submit = (confirmed = false) => {
    const submitted = text();
    const submittedBuffer = currentBuffer;
    const submittedDraftKey = currentDraftKey;
    if (submitted.trim() === "") return;
    const command = commandForInput(submitted, props.commandSpecs ?? []);
    if (!confirmed && command?.confirm === "always") {
      setPendingConfirmation(command);
      if (platform.environment().input !== "touch")
        queueMicrotask(() => confirmButton?.focus());
      return;
    }
    setPendingConfirmation(undefined);
    if (confirmed) queueMicrotask(() => textarea?.focus());
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
  createEffect(() => {
    setSelected(suggestions() === undefined ? -1 : 0);
  });
  const request = (value: string, cursor: number, explicit: boolean) => {
    setCompletionCursor(cursor);
    props.onRequestCandidates?.(value, cursor, explicit);
  };
  const accept = (index = selected() >= 0 ? selected() : 0) => {
    const result = suggestions();
    const candidate = result?.candidates[index];
    if (result === undefined || candidate === undefined) return false;
    const currentText = text();
    const replacement = replacementFor(candidate, {
      ...result,
      input: currentText,
    });
    const replaceEnd =
      result.input === currentText ? result.replace_end : completionCursor();
    const next = `${currentText.slice(0, result.replace_start)}${replacement}${currentText.slice(replaceEnd)}`;
    const cursor = result.replace_start + replacement.length;
    update(next);
    queueMicrotask(() => {
      textarea?.focus({ preventScroll: true });
      textarea?.setSelectionRange(cursor, cursor);
      request(next, cursor, false);
    });
    return true;
  };
  createEffect(() => {
    const result = suggestions();
    if (result === undefined || result.input !== pendingTabInput) return;
    pendingTabInput = undefined;
    queueMicrotask(() => accept(0));
  });
  const move = (offset: -1 | 1) => {
    const count = suggestions()?.candidates.length ?? 0;
    if (count === 0) return false;
    setSelected((selected() + offset + count) % count);
    return true;
  };
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
    if (event.key === "Escape" && suggestions() !== undefined) {
      event.preventDefault();
      setDismissedInput(text());
      setSelected(-1);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!accept()) submit();
    } else if (event.key === "Tab") {
      event.preventDefault();
      if (!accept()) {
        pendingTabInput = text();
        request(text(), textarea?.selectionStart ?? text().length, true);
      }
    } else if (event.key === "ArrowUp" && move(-1)) {
      event.preventDefault();
    } else if (event.key === "ArrowDown" && move(1)) {
      event.preventDefault();
    } else if (
      platform.shortcutPlatform === "macos" &&
      event.ctrlKey &&
      ((event.key.toLowerCase() === "p" && move(-1)) ||
        (event.key.toLowerCase() === "n" && move(1)))
    ) {
      event.preventDefault();
    } else if (event.key === "ArrowUp" && text() === "") {
      props.onSelectLast?.();
    }
  };

  return (
    <div class={styles.wrap} data-composer="true">
      {suggestions() !== undefined && (
        <SuggestionList
          candidates={suggestions()?.candidates ?? []}
          completionInput={suggestions()?.input ?? ""}
          hint={suggestions()?.argument_hint ?? null}
          listId={listId()}
          onAccept={accept}
          onSelect={setSelected}
          optionId={optionId}
          selected={selected()}
        />
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
          <span>{confirmationText()}</span>
          <button
            class={styles.confirm}
            onClick={() => submit(true)}
            onPointerDown={(event) => event.preventDefault()}
            ref={confirmButton}
            type="button"
          >
            {t(pendingConfirmation()?.confirmation_action ?? "")}
          </button>
          <button
            class={styles.cancel}
            onClick={() => {
              setPendingConfirmation(undefined);
              textarea?.focus();
            }}
            onPointerDown={(event) => event.preventDefault()}
            type="button"
          >
            Cancel
          </button>
        </div>
      )}
      <div
        aria-activedescendant={
          suggestions() !== undefined && selected() >= 0
            ? optionId(selected())
            : undefined
        }
        aria-controls={suggestions() !== undefined ? listId() : undefined}
        aria-expanded={suggestions() !== undefined}
        aria-haspopup="listbox"
        aria-label={`Suggestions for ${props.bufferTitle}`}
        class={styles.form}
        role="combobox"
        tabIndex={-1}
      >
        <textarea
          aria-label={`Message ${props.bufferTitle}`}
          autocomplete="off"
          class={styles.input}
          disabled={props.disabled}
          onCompositionEnd={(event) => {
            composing = false;
            const value = event.currentTarget.value;
            update(value);
            request(value, event.currentTarget.selectionStart, false);
          }}
          onCompositionStart={() => {
            composing = true;
            setDismissedInput(text());
            setSelected(-1);
          }}
          onInput={(event) => {
            const value = event.currentTarget.value;
            update(value);
            if (!composing)
              request(value, event.currentTarget.selectionStart, false);
          }}
          onKeyDown={keydown}
          placeholder={`Message ${props.bufferTitle}`}
          ref={textarea}
          rows={1}
          value={text()}
        />
        <button
          class={styles.send}
          disabled={props.disabled}
          onClick={() => {
            submit();
            textarea?.focus();
          }}
          onPointerDown={(event) => event.preventDefault()}
          type="button"
        >
          Send
        </button>
      </div>
      <p aria-live="polite" class="visually-hidden">
        {suggestions() === undefined
          ? ""
          : `${suggestions()?.candidates.length ?? 0} suggestions available`}
      </p>
    </div>
  );
}

export function replacementFor(
  candidate: CompletionCandidate,
  result: Pick<CompletionResult, "argument_hint" | "input" | "replace_start">,
): string {
  switch (candidate.type) {
    case "command":
      return `/${candidate.name} `;
    case "person":
      if (
        result.replace_start === 0 &&
        result.input.startsWith("@", result.replace_start)
      )
        return `${candidate.nick}: `;
      return `${candidate.nick}${result.input.startsWith("@", result.replace_start) && result.argument_hint === null ? "" : " "}`;
    case "channel":
      return `${candidate.name}${result.argument_hint === null ? "" : " "}`;
  }
}
