import {
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  on,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import type {
  CommandSpec,
  CompletionCandidate,
  CompletionResult,
  TypingProjection,
} from "../../engine/protocol";
import { platformEnvironment } from "../../platform/environment";
import {
  focusWithoutViewportPan,
  TouchTapGesture,
} from "../../platform/focus-without-pan";
import { reportKeyboardInteraction } from "../../platform/keyboard-debug";
import { t, translate } from "../../strings";
import { onPointerDownOutside } from "../../ui/outside-pointer";
import styles from "../conversation/SimpleComposer.module.css";
import type { NetworkUploads } from "../uploads/types";
import { AttachmentChip } from "./AttachmentChip";
import { attachableImage, type ImageRejection } from "./attachable-image";
import { createAttachmentController } from "./attachment-controller";
import { imageFromClipboard } from "./clipboard-image";
import { bareCommandForInput, commandForInput } from "./command-input";
import { readDraft, removeDraft, writeDraft } from "./draft-storage";
import {
  composerGeometryChangeEvent,
  composerGeometryWillChangeEvent,
  contentFittingHeight,
  withBlockSizeHeld,
} from "./geometry";
import { ImagePicker } from "./ImagePicker";
import { InlineConfirmation } from "./InlineConfirmation";
import { type DropAvailability, imageDropTargets } from "./image-drop";
import { SuggestionList } from "./SuggestionList";
import { isSecretInput } from "./secret-input";
import { TypingIndicator } from "./TypingIndicator";
import { type UploadNote, UploadOverlays } from "./UploadOverlays";

interface ComposerProps {
  readonly bufferId: number;
  readonly bufferKind?: "channel" | "direct" | "server" | undefined;
  readonly draftKey: string;
  readonly bufferTitle: string;
  readonly commandSpecs?: readonly CommandSpec[] | undefined;
  readonly completion?: CompletionResult | undefined;
  readonly disabled?: boolean;
  readonly focusOnMount?: boolean | undefined;
  readonly onRequestCandidates?: (
    input: string,
    cursor: number,
    explicit: boolean,
  ) => void;
  readonly onSelectLast?: () => void;
  readonly onSend: (
    text: string,
  ) => boolean | undefined | Promise<boolean | undefined>;
  readonly typers?: readonly TypingProjection[] | undefined;
  readonly uploads?: NetworkUploads | undefined;
}

interface ComposerInput {
  readonly text: string;
  readonly caret: number;
}

function caretAtEnd(text: string): ComposerInput {
  return { text, caret: text.length };
}

interface TabCycle {
  readonly result: CompletionResult;
  readonly index: number;
  readonly currentInput: string;
}

export function Composer(props: ComposerProps) {
  const platform = platformEnvironment();
  let wrap: HTMLDivElement | undefined;
  let textarea: HTMLTextAreaElement | undefined;
  let confirmButton: HTMLButtonElement | undefined;
  let imagePicker: HTMLInputElement | undefined;
  let composing = false;
  let caretScrollFrame: number | undefined;
  let pendingTabInput: string | undefined;
  let tabCycle: TabCycle | undefined;
  const touchFocus = new TouchTapGesture();
  let currentBuffer = props.bufferId;
  let currentDraftKey = props.draftKey;
  const [input, setInput] = createSignal(
    caretAtEnd(readDraft(currentDraftKey)),
  );
  const text = createMemo(() => input().text);
  const completionCursor = () => input().caret;
  const setText = (value: string) => setInput(caretAtEnd(value));
  const setCaret = (caret: number) =>
    setInput((current) => ({ ...current, caret }));
  const [selected, setSelected] = createSignal(-1);
  const [dismissedInput, setDismissedInput] = createSignal<string>();
  const [pendingConfirmation, setPendingConfirmation] =
    createSignal<CommandSpec>();
  const [uploadNote, setUploadNote] = createSignal<UploadNote>();
  const attachments = createAttachmentController({
    uploads: () => props.uploads,
  });
  const focusAfterOverlay = () => {
    if (platform.environment().input !== "touch")
      queueMicrotask(() => textarea?.focus({ preventScroll: true }));
  };
  const dropAttachment = () => {
    attachments.remove();
    setUploadNote(undefined);
  };
  // The chip, the note and the replace question resize the composer like a new text line, so
  // the message list keeps its live edge through the same geometry events: the computation
  // announces the change before Solid updates the DOM, the effect after it.
  const uploadSurfaces = createMemo(
    () =>
      [
        attachments.attachment() !== undefined,
        uploadNote() !== undefined,
        attachments.pendingReplacement() !== undefined,
      ] as const,
    undefined,
    {
      equals: (previous, next) =>
        previous.every((shown, index) => shown === next[index]),
    },
  );
  const announceGeometry = (event: string) =>
    textarea?.dispatchEvent(new Event(event, { bubbles: true }));
  createComputed(
    on(
      uploadSurfaces,
      () => announceGeometry(composerGeometryWillChangeEvent),
      { defer: true },
    ),
  );
  createEffect(
    on(uploadSurfaces, () => announceGeometry(composerGeometryChangeEvent), {
      defer: true,
    }),
  );
  const listId = () => `composer-completions-${props.bufferId}`;
  const optionId = (index: number) => `${listId()}-${index}`;
  const suggestions = createMemo(() => {
    const result = props.completion;
    if (
      result?.buffer_id !== props.bufferId ||
      result.auto_accept ||
      text() === dismissedInput() ||
      result.candidates.length === 0
    )
      return undefined;
    const input = text();
    if (result.input.startsWith(input) && result.input !== input)
      return completionTriggerRemains(result, input, completionCursor())
        ? result
        : undefined;
    if (!input.startsWith(result.input)) return undefined;
    const query = input.slice(result.replace_start, completionCursor());
    const candidates = result.candidates.filter((candidate) =>
      candidateMatches(candidate, query),
    );
    if (candidates.length > 0) return { ...result, candidates };
    return result.input === input ? result : undefined;
  });
  const confirmationText = () => {
    const command = pendingConfirmation();
    const prompt = command?.confirmation_prompt;
    return prompt === undefined
      ? ""
      : translate(prompt, { text: props.bufferTitle });
  };
  const resize = () => {
    if (textarea === undefined) return;
    if (caretScrollFrame !== undefined) {
      cancelAnimationFrame(caretScrollFrame);
      caretScrollFrame = undefined;
    }
    const previousHeight = textarea.style.height;
    const previousScrollTop = textarea.scrollTop;
    const caretIsAtEnd = textarea.selectionEnd === textarea.value.length;
    const input = textarea;
    const nextHeight = withBlockSizeHeld(input.parentElement, () => {
      input.style.height = "0";
      const measured = `${contentFittingHeight(input)}px`;
      if (measured !== previousHeight)
        input.dispatchEvent(
          new Event(composerGeometryWillChangeEvent, { bubbles: true }),
        );
      input.style.height = measured;
      return measured;
    });
    const caretNeedsDeferredReveal =
      caretIsAtEnd &&
      platform.environment().input === "touch" &&
      textarea.scrollHeight > textarea.clientHeight &&
      textarea === document.activeElement;
    textarea.scrollTop = caretIsAtEnd
      ? textarea.scrollHeight
      : previousScrollTop;
    if (caretNeedsDeferredReveal) {
      const resized = textarea;
      // WebKit performs its native caret reveal after autosizing, so win the
      // final pre-paint scroll without overriding a later selection change.
      caretScrollFrame = requestAnimationFrame(() => {
        caretScrollFrame = undefined;
        if (
          resized.isConnected &&
          resized.selectionEnd === resized.value.length
        )
          resized.scrollTop = resized.scrollHeight;
      });
    }
    if (nextHeight !== previousHeight)
      textarea.dispatchEvent(
        new Event(composerGeometryChangeEvent, { bubbles: true }),
      );
  };

  onCleanup(() => {
    if (caretScrollFrame !== undefined) cancelAnimationFrame(caretScrollFrame);
    dropAttachment();
  });

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
    if (props.bufferId === currentBuffer && props.draftKey === currentDraftKey)
      return;
    if (props.bufferId === currentBuffer) {
      currentDraftKey = props.draftKey;
      if (text() === "") setText(readDraft(currentDraftKey));
      return;
    }
    currentBuffer = props.bufferId;
    currentDraftKey = props.draftKey;
    setText(readDraft(currentDraftKey));
    setSelected(-1);
    setDismissedInput(undefined);
    setPendingConfirmation(undefined);
    dropAttachment();
    pendingTabInput = undefined;
    tabCycle = undefined;
  });

  const update = (
    value: string,
    caret = value.length,
    preserveTabCycle = false,
  ) => {
    if (!preserveTabCycle) {
      pendingTabInput = undefined;
      tabCycle = undefined;
    }
    setInput({ text: value, caret });
    setPendingConfirmation(undefined);
    setUploadNote(undefined);
    setSelected(-1);
    if (dismissedInput() !== value) setDismissedInput(undefined);
  };
  const deliver = (
    submitted: string,
    message = submitted,
    submittedBuffer = currentBuffer,
    submittedDraftKey = currentDraftKey,
  ) =>
    Promise.resolve(props.onSend(message))
      .then((accepted) => {
        if (accepted === false) return false;
        if (readDraft(submittedDraftKey) === submitted) {
          removeDraft(submittedDraftKey);
        }
        if (currentBuffer === submittedBuffer && text() === submitted) {
          setText("");
          setSelected(-1);
        }
        return true;
      })
      .catch(() => false);
  const submit = (confirmed = false) => {
    const submitted = text();
    if (attachments.attachment() !== undefined) {
      const buffer = currentBuffer;
      const draftKey = currentDraftKey;
      void attachments.send(submitted, props.commandSpecs ?? [], (message) =>
        deliver(submitted, message, buffer, draftKey),
      );
      return;
    }
    if (submitted.trim() === "") return;
    const command = commandForInput(submitted, props.commandSpecs ?? []);
    if (
      !confirmed &&
      (command?.confirm === "always" ||
        (command?.name === "close" && props.bufferKind === "channel"))
    ) {
      setPendingConfirmation(command);
      if (platform.environment().input !== "touch")
        queueMicrotask(() => confirmButton?.focus());
      return;
    }
    setPendingConfirmation(undefined);
    if (confirmed) queueMicrotask(() => textarea?.focus());
    void deliver(submitted);
  };
  const sendEmpty = () =>
    text().trim() === "" && attachments.attachment() === undefined;
  const paste = (event: ClipboardEvent) => {
    const image = imageFromClipboard(event.clipboardData);
    if (image === undefined) return;
    if (props.uploads === undefined) {
      setUploadNote("unavailable");
      return;
    }
    if (!image.hasText) event.preventDefault();
    void attachNoting(image.file);
  };
  const attachImage = (file: File) => {
    setUploadNote(undefined);
    attachments.attach(file);
  };
  /** The one attach path for every file; it answers why a file was refused. */
  const attachFile = async (
    file: File,
  ): Promise<ImageRejection | undefined> => {
    const buffer = currentBuffer;
    const checked = await attachableImage(file);
    if (buffer !== currentBuffer) return undefined;
    if (checked.kind === "rejected") return checked.reason;
    attachImage(checked.file);
    return undefined;
  };
  const attachNoting = async (file: File) => {
    const rejection = await attachFile(file);
    if (rejection !== undefined) setUploadNote(rejection);
  };
  const dropAvailability = (): DropAvailability => {
    if (props.disabled === true) return "closed";
    return props.uploads === undefined ? "unavailable" : "ready";
  };
  const dropTarget = imageDropTargets.register({
    availability: dropAvailability,
    attach: attachFile,
    focus: focusAfterOverlay,
  });
  onCleanup(() => dropTarget.unregister());
  // Safari opens a file picker only inside the user's gesture, so this runs synchronously from
  // Enter or Send, before anything reaches the engine.
  const runFileCommand = () => {
    if (bareCommandForInput(text(), props.commandSpecs ?? [])?.name !== "file")
      return false;
    update("");
    if (props.uploads === undefined) setUploadNote("unavailable");
    else imagePicker?.click();
    return true;
  };
  const send = () => {
    if (runFileCommand()) return;
    submit();
    textarea?.focus();
  };
  createEffect(() => {
    setSelected(suggestions() === undefined ? -1 : 0);
  });
  const dismissSuggestions = () => {
    setDismissedInput(text());
    setSelected(-1);
  };
  const suggesting = createMemo(() => suggestions() !== undefined);
  createEffect(() => {
    if (suggesting()) onPointerDownOutside(() => [wrap], dismissSuggestions);
  });
  const request = (value: string, cursor: number, explicit: boolean) => {
    setCaret(cursor);
    props.onRequestCandidates?.(value, cursor, explicit);
  };
  const applyTabCycle = (index: number) => {
    const cycle = tabCycle;
    const candidate = cycle?.result.candidates[index];
    if (cycle === undefined || candidate === undefined) return false;
    const result = cycle.result;
    const replacement = replacementFor(candidate, result);
    const next = `${result.input.slice(0, result.replace_start)}${replacement}${result.input.slice(result.replace_end)}`;
    const cursor = result.replace_start + replacement.length;
    tabCycle = { result, index, currentInput: next };
    update(next, cursor, true);
    queueMicrotask(() => {
      textarea?.focus({ preventScroll: true });
      textarea?.setSelectionRange(cursor, cursor);
      request(next, cursor, false);
    });
    return true;
  };
  const applyCandidate = (
    result: CompletionResult,
    candidate: CompletionCandidate,
    acceptSeparatorOnly: boolean,
  ) => {
    const currentText = text();
    const replacement = replacementFor(candidate, result);
    const replaceEnd =
      result.input === currentText ? result.replace_end : completionCursor();
    const next = `${currentText.slice(0, result.replace_start)}${replacement}${currentText.slice(replaceEnd)}`;
    if (!acceptSeparatorOnly && next.trimEnd() === currentText.trimEnd())
      return false;
    const cursor = result.replace_start + replacement.length;
    update(next, cursor);
    queueMicrotask(() => {
      textarea?.focus({ preventScroll: true });
      textarea?.setSelectionRange(cursor, cursor);
      request(next, cursor, false);
    });
    return true;
  };
  const accept = (
    index = selected() >= 0 ? selected() : 0,
    acceptSeparatorOnly = true,
  ) => {
    const result = suggestions();
    const candidate = result?.candidates[index];
    if (result === undefined || candidate === undefined) return false;
    return applyCandidate(result, candidate, acceptSeparatorOnly);
  };
  createEffect(() => {
    const result = props.completion;
    const candidate = result?.candidates[0];
    if (
      result?.auto_accept !== true ||
      candidate === undefined ||
      result.buffer_id !== props.bufferId ||
      result.input !== untrack(text) ||
      textarea?.selectionEnd !== result.replace_end ||
      composing
    )
      return;
    applyCandidate(result, candidate, true);
  });
  createEffect(() => {
    const result = suggestions();
    if (result === undefined || result.input !== pendingTabInput) return;
    pendingTabInput = undefined;
    tabCycle = { result, index: 0, currentInput: result.input };
    queueMicrotask(() => applyTabCycle(0));
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
      dismissSuggestions();
    } else if (
      event.key === "Escape" &&
      text() === "" &&
      attachments.attachment() !== undefined
    ) {
      event.preventDefault();
      dropAttachment();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!accept(undefined, false) && !runFileCommand()) submit();
    } else if (event.key === "Tab" && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const cycle = tabCycle;
      if (
        cycle !== undefined &&
        cycle.currentInput === text() &&
        cycle.result.candidates.length > 0
      ) {
        applyTabCycle((cycle.index + 1) % cycle.result.candidates.length);
      } else if (!accept()) {
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
  const focusFromTap = (event: TouchEvent, field: HTMLTextAreaElement) => {
    const touch = event.changedTouches[0];
    const tap =
      touch === undefined
        ? { accepted: false as const, reason: "no changed touch" }
        : touchFocus.end(touch, event.timeStamp);
    reportKeyboardInteraction(
      tap.accepted ? "touchend:tap" : `touchend:rejected(${tap.reason})`,
    );
    if (
      !tap.accepted ||
      platform.environment().input !== "touch" ||
      document.activeElement === field ||
      !tapMayFocusComposer(event.target, event.currentTarget)
    )
      return;
    event.preventDefault();
    reportKeyboardInteraction(
      focusWithoutViewportPan(field) ? "focus:landed" : "focus:refused",
    );
  };

  return (
    <div
      class={styles.wrap}
      ref={wrap}
      data-composer="true"
      data-keyboard-focus-surface="true"
      onTouchCancel={() => {
        reportKeyboardInteraction("touchcancel");
        touchFocus.cancel();
      }}
      onTouchEnd={(event) => {
        if (textarea !== undefined) focusFromTap(event, textarea);
      }}
      onTouchMove={(event) => {
        const touch = event.touches[0];
        if (event.touches.length === 1 && touch !== undefined)
          touchFocus.move(touch);
        else touchFocus.cancel();
      }}
      onTouchStart={(event) => {
        reportKeyboardInteraction("touchstart");
        const touch = event.changedTouches[0];
        if (event.touches.length === 1 && touch !== undefined)
          touchFocus.begin(touch, event.timeStamp);
        else touchFocus.cancel();
      }}
    >
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
      <TypingIndicator typers={props.typers ?? []} />
      <ImagePicker
        onPick={(file) => void attachNoting(file).then(focusAfterOverlay)}
        inputRef={(input) => {
          imagePicker = input;
        }}
      />
      <UploadOverlays
        attachments={attachments}
        onSettled={focusAfterOverlay}
        note={uploadNote()}
      />
      {pendingConfirmation() !== undefined && (
        <InlineConfirmation
          action={translate(pendingConfirmation()?.confirmation_action ?? "")}
          confirmRef={(button) => {
            confirmButton = button;
          }}
          label={t("composer.confirm", {
            command: pendingConfirmation()?.name ?? "",
          })}
          message={confirmationText()}
          onCancel={() => {
            setPendingConfirmation(undefined);
            queueMicrotask(() => textarea?.focus());
          }}
          onConfirm={() => submit(true)}
        />
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
        aria-label={t("composer.suggestions", { target: props.bufferTitle })}
        class={styles.form}
        role="combobox"
        tabIndex={-1}
      >
        <div
          class={styles.field}
          data-composer-field="true"
          data-attachment={attachments.attachment() !== undefined}
        >
          <Show when={attachments.attachment()}>
            {(attachment) => (
              <AttachmentChip
                attachment={attachment()}
                onRemove={() => {
                  dropAttachment();
                  focusAfterOverlay();
                }}
                onRetry={() => submit()}
              />
            )}
          </Show>
          <div class={styles.entryRow}>
            <textarea
              aria-label={t("composer.input", { target: props.bufferTitle })}
              autocomplete="off"
              class={styles.input}
              disabled={props.disabled}
              onCompositionEnd={(event) => {
                composing = false;
                const value = event.currentTarget.value;
                update(value, event.currentTarget.selectionStart);
                request(value, event.currentTarget.selectionStart, false);
              }}
              onCompositionStart={() => {
                composing = true;
                dismissSuggestions();
              }}
              onInput={(event) => {
                const value = event.currentTarget.value;
                update(value, event.currentTarget.selectionStart);
                if (!composing) {
                  request(value, event.currentTarget.selectionStart, false);
                }
              }}
              onFocus={() => dropTarget.raise()}
              onKeyDown={keydown}
              onPaste={paste}
              placeholder={t("composer.input", { target: props.bufferTitle })}
              ref={(element) => {
                textarea = element;
                if (props.focusOnMount === true)
                  requestAnimationFrame(() => {
                    if (element.isConnected)
                      element.focus({ preventScroll: true });
                  });
              }}
              rows={1}
              value={text()}
            />
            <button
              aria-label={t("common.send")}
              class={`${styles.send} ${styles.touchSend}`}
              data-composer-send="true"
              data-busy={attachments.busy()}
              data-empty={sendEmpty()}
              disabled={props.disabled}
              onClick={send}
              onPointerDown={(event) => event.preventDefault()}
              onTouchEnd={(event) => {
                event.preventDefault();
                send();
              }}
              type="button"
            >
              <span data-composer-send-visual="true">
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </span>
            </button>
          </div>
        </div>
        <button
          class={`${styles.send} ${styles.desktopSend}`}
          data-composer-send="true"
          aria-busy={attachments.busy()}
          data-busy={attachments.busy()}
          data-empty={sendEmpty()}
          disabled={props.disabled}
          onClick={send}
          onPointerDown={(event) => event.preventDefault()}
          type="button"
        >
          {t("common.send")}
        </button>
      </div>
      <p aria-live="polite" class="visually-hidden">
        {suggestions() === undefined
          ? ""
          : t("composer.suggestions_available", {
              count: String(suggestions()?.candidates.length ?? 0),
            })}
      </p>
    </div>
  );
}

function tapMayFocusComposer(
  target: EventTarget | null,
  surface: EventTarget | null,
): boolean {
  if (!(target instanceof Element) || !(surface instanceof Element))
    return false;
  if (target.closest("button, [role='option'], [role='alertdialog']") !== null)
    return false;
  return target === surface || target.closest("[role='combobox']") !== null;
}

function candidateMatches(
  candidate: CompletionCandidate,
  query: string,
): boolean {
  const normalized = query.toLocaleLowerCase();
  switch (candidate.type) {
    case "command":
      return `/${candidate.name.toLocaleLowerCase()}`.startsWith(normalized);
    case "person":
      return candidate.nick
        .toLocaleLowerCase()
        .startsWith(
          normalized.startsWith("@") ? normalized.slice(1) : normalized,
        );
    case "channel":
      return candidate.name.toLocaleLowerCase().startsWith(normalized);
  }
}

function completionTriggerRemains(
  result: CompletionResult,
  input: string,
  cursor: number,
): boolean {
  const query = input.slice(result.replace_start, cursor);
  if (result.argument_hint !== null) return cursor >= result.replace_start;
  switch (result.trigger) {
    case "command":
      return query.startsWith("/");
    case "person":
      return result.input.startsWith("@", result.replace_start)
        ? query.startsWith("@")
        : query.length > 0;
    case "channel":
      return query.startsWith(result.input[result.replace_start] ?? "\0");
  }
}

export function replacementFor(
  candidate: CompletionCandidate,
  result: Pick<CompletionResult, "replacement_prefix" | "replacement_suffix">,
): string {
  let value: string;
  switch (candidate.type) {
    case "command":
      value = candidate.name;
      break;
    case "person":
      value = candidate.nick;
      break;
    case "channel":
      value = candidate.name;
      break;
  }
  return `${result.replacement_prefix}${value}${result.replacement_suffix}`;
}
