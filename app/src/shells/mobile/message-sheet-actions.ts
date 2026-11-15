import type { Component } from "solid-js";
import type { MessageProjection } from "../../engine/protocol";
import { t } from "../../strings";
import { CopyIcon } from "../../ui/icons/CopyIcon";
import { TrashIcon } from "../../ui/icons/TrashIcon";

export interface MessageSheetAction {
  readonly id: string;
  readonly label: string;
  readonly icon: Component<{ readonly class?: string | undefined }>;
  readonly run: () => void;
  readonly tone?: "danger" | undefined;
}

export interface MessageSheetCommands {
  readonly copyText: (text: string) => void;
  /** Present only for a message you can delete; it asks before deleting. */
  readonly delete?: (() => void) | undefined;
}

/** The phone sheet's list below the reactions, in display order. */
export function messageSheetActions(
  message: MessageProjection,
  commands: MessageSheetCommands,
): readonly MessageSheetAction[] {
  const copy: MessageSheetAction = {
    id: "copy-text",
    label: t("mobile.copy_text"),
    icon: CopyIcon,
    run: () => commands.copyText(message.text),
  };
  const remove = commands.delete;
  const deletion: readonly MessageSheetAction[] =
    remove === undefined
      ? []
      : [
          {
            id: "delete",
            label: t("message.delete"),
            icon: TrashIcon,
            run: remove,
            tone: "danger",
          },
        ];
  return [copy, ...deletion];
}
