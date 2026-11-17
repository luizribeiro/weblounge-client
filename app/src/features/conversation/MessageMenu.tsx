import { createSignal, type JSX, Show } from "solid-js";
import type { MessageId } from "../../engine/generated/MessageId";
import type { MessageProjection } from "../../engine/generated/MessageProjection";
import { isRedacted } from "../../engine/message-kind";
import { t } from "../../strings";
import { ConfirmationDialog } from "../../ui/ConfirmationDialog";
import { ContextMenu, type ContextMenuItem } from "../../ui/ContextMenu";
import type { ContextMenuRequest } from "../../ui/context-menu";
import { copyText } from "../../ui/copy-text";
import { canRedact, type RedactMessage } from "./redact-target";

/** What a desktop message row needs to open its actions menu. */
export interface MessageRowMenu {
  readonly redact: RedactMessage | undefined;
  readonly openMenu: (
    message: MessageProjection,
    request: ContextMenuRequest,
  ) => void;
}

export interface MessageMenu {
  readonly row: () => MessageRowMenu;
  /** The message whose row menu is open. */
  readonly menuRow: () => MessageId | undefined;
  /** Asks before deleting, as every entry point must; does nothing for other rows. */
  readonly confirmDelete: (
    message: MessageProjection,
    invoker: HTMLElement,
  ) => void;
  readonly view: () => JSX.Element;
}

interface OpenedMenu {
  readonly message: MessageProjection;
  readonly request: ContextMenuRequest;
}

interface PendingDeletion {
  readonly message: MessageProjection;
  readonly invoker: HTMLElement;
}

/** Every message with text has a menu; a deleted one has nothing to copy or delete. */
export function hasMessageMenu(message: MessageProjection): boolean {
  return !isRedacted(message.kind);
}

export function createMessageMenu(
  redact: () => RedactMessage | undefined,
): MessageMenu {
  const [opened, setOpened] = createSignal<OpenedMenu>();
  const [pending, setPending] = createSignal<PendingDeletion>();
  const confirmDelete = (message: MessageProjection, invoker: HTMLElement) => {
    if (canRedact(message, redact())) setPending({ message, invoker });
  };
  const close = (deletion: PendingDeletion) => {
    setPending(undefined);
    queueMicrotask(() => deletion.invoker.focus({ preventScroll: true }));
  };
  const copyItems = (menu: OpenedMenu | undefined): ContextMenuItem[] =>
    menu === undefined || !hasMessageMenu(menu.message)
      ? []
      : [
          {
            id: "message.copy_text",
            label: t("message.copy_text"),
            onSelect: () => copyText(menu.message.text),
          },
        ];
  const deleteItems = (menu: OpenedMenu | undefined): ContextMenuItem[] =>
    menu === undefined || !canRedact(menu.message, redact())
      ? []
      : [
          {
            id: "message.redact",
            label: t("message.delete"),
            onSelect: () => confirmDelete(menu.message, menu.request.invoker),
          },
        ];
  return {
    row: () => ({
      redact: redact(),
      openMenu: (message, request) => setOpened({ message, request }),
    }),
    menuRow: () => opened()?.message.id,
    confirmDelete,
    view: () => (
      <>
        <ContextMenu
          destructiveItems={deleteItems(opened())}
          items={copyItems(opened())}
          label={t("message.actions")}
          onDismiss={() => setOpened(undefined)}
          request={opened()?.request}
        />
        <Show when={pending()} keyed>
          {(deletion) => (
            <ConfirmationDialog
              action={t("message.delete_action")}
              explanation={t("message.delete_explanation")}
              label={t("message.delete_prompt")}
              message={t("message.delete_prompt")}
              onCancel={() => close(deletion)}
              onConfirm={() => {
                close(deletion);
                redact()?.(deletion.message.id);
              }}
            />
          )}
        </Show>
      </>
    ),
  };
}
