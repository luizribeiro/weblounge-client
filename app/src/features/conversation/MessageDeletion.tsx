import { createSignal, type JSX, Show } from "solid-js";
import type { MessageId } from "../../engine/generated/MessageId";
import type { MessageProjection } from "../../engine/generated/MessageProjection";
import { t } from "../../strings";
import { ConfirmationDialog } from "../../ui/ConfirmationDialog";
import { ContextMenu, type ContextMenuItem } from "../../ui/ContextMenu";
import type { ContextMenuRequest } from "../../ui/context-menu";
import { canRedact, type RedactMessage } from "./redact-target";

/** What a message row needs to offer deletion of its message. */
export interface MessageRowDeletion {
  readonly redact: RedactMessage;
  readonly openMenu: (
    message: MessageProjection,
    request: ContextMenuRequest,
  ) => void;
}

export interface MessageDeletion {
  /** Row actions, absent when the network cannot delete messages. */
  readonly rows: () => MessageRowDeletion | undefined;
  /** The message whose row menu is open. */
  readonly menuRow: () => MessageId | undefined;
  /** Asks before deleting, as every entry point must; does nothing for other rows. */
  readonly confirm: (message: MessageProjection, invoker: HTMLElement) => void;
  readonly view: () => JSX.Element;
}

interface MessageMenu {
  readonly message: MessageProjection;
  readonly request: ContextMenuRequest;
}

interface PendingDeletion {
  readonly message: MessageProjection;
  readonly invoker: HTMLElement;
}

export function createMessageDeletion(
  redact: () => RedactMessage | undefined,
): MessageDeletion {
  const [menu, setMenu] = createSignal<MessageMenu>();
  const [pending, setPending] = createSignal<PendingDeletion>();
  const confirm = (message: MessageProjection, invoker: HTMLElement) => {
    if (canRedact(message, redact())) setPending({ message, invoker });
  };
  const close = (deletion: PendingDeletion) => {
    setPending(undefined);
    queueMicrotask(() => deletion.invoker.focus({ preventScroll: true }));
  };
  const menuItems = (opened: MessageMenu | undefined): ContextMenuItem[] =>
    opened === undefined
      ? []
      : [
          {
            id: "message.redact",
            label: t("message.delete"),
            onSelect: () => confirm(opened.message, opened.request.invoker),
          },
        ];
  return {
    rows: () => {
      const current = redact();
      return current === undefined
        ? undefined
        : {
            redact: current,
            openMenu: (message, request) => setMenu({ message, request }),
          };
    },
    menuRow: () => menu()?.message.id,
    confirm,
    view: () => (
      <>
        <ContextMenu
          destructiveItems={menuItems(menu())}
          label={t("message.actions")}
          onDismiss={() => setMenu(undefined)}
          request={menu()?.request}
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
