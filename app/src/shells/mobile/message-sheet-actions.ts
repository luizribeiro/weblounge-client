import type { Component } from "solid-js";
import type { MessageProjection } from "../../engine/protocol";
import { t } from "../../strings";
import { CopyIcon } from "../../ui/icons/CopyIcon";

export interface MessageSheetAction {
  readonly id: string;
  readonly label: string;
  readonly icon: Component<{ readonly class?: string | undefined }>;
  readonly run: () => void;
  readonly tone?: "danger" | undefined;
}

export interface MessageSheetCommands {
  readonly copyText: (text: string) => void;
}

/** The phone sheet's list below the reactions, in display order. */
export function messageSheetActions(
  message: MessageProjection,
  commands: MessageSheetCommands,
): readonly MessageSheetAction[] {
  return [
    {
      id: "copy-text",
      label: t("mobile.copy_text"),
      icon: CopyIcon,
      run: () => commands.copyText(message.text),
    },
  ];
}
