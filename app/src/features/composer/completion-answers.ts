import type { CompletionResult } from "../../engine/protocol";

export interface CompletionAnswers {
  begin(id: string): void;
  answer(result: CompletionResult): void;
  /** The engine answers a request with no trigger in its text by finishing it without a result. */
  settle(id: string): void;
}

export function createCompletionAnswers(
  show: (result: CompletionResult | undefined) => void,
  delay: () => number,
): CompletionAnswers {
  let latest: string | undefined;
  let answered: string | undefined;
  const apply = (id: string, result: CompletionResult | undefined) => {
    if (id !== latest) return;
    const wait = delay();
    if (wait === 0) show(result);
    else
      setTimeout(() => {
        if (id === latest) show(result);
      }, wait);
  };
  return {
    begin(id) {
      latest = id;
    },
    answer(result) {
      if (result.command_id !== latest) return;
      answered = result.command_id;
      apply(result.command_id, result);
    },
    settle(id) {
      if (answered !== id) apply(id, undefined);
    },
  };
}
