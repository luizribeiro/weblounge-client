import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";
import type { CommandUsage, CompletionResult } from "../../engine/protocol";

interface UsageHintSource {
  readonly bufferId: Accessor<number>;
  readonly completion: Accessor<CompletionResult | undefined>;
  readonly text: Accessor<string>;
}

export interface UsageHint {
  readonly usage: Accessor<CommandUsage | undefined>;
  /** Hides the hint until the typed command changes or the text stops being one. */
  readonly dismiss: () => void;
}

export function createUsageHint(source: UsageHintSource): UsageHint {
  const current = createMemo(() => {
    const result = source.completion();
    if (result?.buffer_id !== source.bufferId() || result.usage === null)
      return undefined;
    return answersText(result.input, source.text()) ? result.usage : undefined;
  });
  const [dismissed, setDismissed] = createSignal<string>();
  createEffect(() => {
    if (current()?.name !== dismissed()) setDismissed(undefined);
  });
  return {
    usage: () => {
      const usage = current();
      return usage?.name === dismissed() ? undefined : usage;
    },
    dismiss: () => setDismissed(current()?.name),
  };
}

/**
 * The composer asks again on every edit, so the latest answer stands for text one edit away
 * while the next reply is in flight; text without whitespace has no arguments to describe.
 */
function answersText(answered: string, text: string): boolean {
  return (
    text.startsWith(answered) || (answered.startsWith(text) && /\s/u.test(text))
  );
}
