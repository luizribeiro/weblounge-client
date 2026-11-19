import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompletionResult } from "../../engine/protocol";
import { createCompletionAnswers } from "./completion-answers";

function result(id: string, input: string): CompletionResult {
  return {
    type: "completion_result",
    command_id: id,
    buffer_id: 7,
    input,
    trigger: "person",
    replace_start: 0,
    replace_end: input.length,
    argument_hint: null,
    replacement_prefix: "",
    replacement_suffix: ": ",
    auto_accept: false,
    candidates: [
      {
        type: "person",
        nick: "checksumbyte",
        nick_color_index: 3,
        away: false,
        bot: false,
      },
    ],
  };
}

function tracked(delay = 0) {
  const shown: (CompletionResult | undefined)[] = [];
  const answers = createCompletionAnswers(
    (value) => shown.push(value),
    () => delay,
  );
  return { answers, shown };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("completion answers", () => {
  it("shows the answer to the latest request", () => {
    const { answers, shown } = tracked();
    const answer = result("tab", "");
    answers.begin("tab");
    answers.answer(answer);
    answers.settle("tab");
    expect(shown).toEqual([answer]);
  });

  it("clears the shown answer when the next request finds nothing to complete", () => {
    const { answers, shown } = tracked();
    answers.begin("tab");
    answers.answer(result("tab", ""));
    answers.settle("tab");
    answers.begin("typed");
    answers.settle("typed");
    expect(shown.at(-1)).toBeUndefined();
  });

  it("ignores answers and settlements of superseded requests", () => {
    const { answers, shown } = tracked();
    answers.begin("first");
    answers.begin("second");
    answers.answer(result("first", "@c"));
    answers.settle("first");
    expect(shown).toEqual([]);
  });

  it("delays answers and clears alike, dropping them once superseded", () => {
    vi.useFakeTimers();
    const { answers, shown } = tracked(50);
    answers.begin("first");
    answers.answer(result("first", "@c"));
    answers.settle("first");
    answers.begin("second");
    answers.settle("second");
    answers.begin("third");
    vi.runAllTimers();
    expect(shown).toEqual([]);
    answers.settle("third");
    vi.runAllTimers();
    expect(shown).toEqual([undefined]);
  });
});
