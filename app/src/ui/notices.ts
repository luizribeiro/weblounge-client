import { type Accessor, createSignal } from "solid-js";
import type { ActionId } from "../actions/action-registry";
import type { MessageKey, MessageValues } from "../features/composer/strings";

export interface NoticeInput {
  readonly message: {
    readonly key: MessageKey;
    readonly values?: MessageValues;
  };
  readonly tone: "error" | "neutral";
  readonly action?: {
    readonly label: MessageKey;
    readonly run: ActionId;
  };
}

export interface ToastNotice extends NoticeInput {
  readonly id: string;
}

export interface Notifier {
  readonly notice: Accessor<ToastNotice | undefined>;
  readonly notify: (input: NoticeInput) => void;
  readonly dismiss: (id: string) => void;
}

export function createNotifier(): Notifier {
  const [notice, setNotice] = createSignal<ToastNotice>();
  return {
    notice,
    notify: (input) => setNotice({ ...input, id: crypto.randomUUID() }),
    dismiss: (id) =>
      setNotice((current) => (current?.id === id ? undefined : current)),
  };
}
