import { createRoot, createSignal } from "solid-js";
import { expect, it } from "vitest";
import type { CommandUsage, CompletionResult } from "../../engine/protocol";
import { createUsageHint } from "./usage-hint";

const kickUsage = (active_argument: number): CommandUsage => ({
  name: "kick",
  arguments: [
    { name: "nick", kind: "nick", required: true, rest: false },
    { name: "reason", kind: "text", required: false, rest: true },
  ],
  active_argument,
});

const joinUsage: CommandUsage = {
  name: "join",
  arguments: [
    { name: "channels", kind: "channel_list", required: true, rest: false },
    { name: "keys", kind: "key_list", required: false, rest: false },
  ],
  active_argument: 0,
};

function answer(input: string, usage: CommandUsage | null): CompletionResult {
  return {
    type: "completion_result",
    command_id: `complete:${input}`,
    buffer_id: 3,
    input,
    trigger: null,
    replace_start: input.length,
    replace_end: input.length,
    usage,
    replacement_prefix: "",
    replacement_suffix: "",
    auto_accept: false,
    candidates: [],
  };
}

function hint(initial: string, result: CompletionResult) {
  return createRoot((dispose) => {
    const [text, setText] = createSignal(initial);
    const [completion, setCompletion] = createSignal<CompletionResult>(result);
    const usageHint = createUsageHint({
      bufferId: () => 3,
      completion,
      text,
    });
    return { usageHint, setText, setCompletion, dispose };
  });
}

it("keeps the last answer's usage until the next answer arrives", () => {
  const { usageHint, setText, dispose } = hint(
    "/kick mel link",
    answer("/kick mel link", kickUsage(1)),
  );
  expect(usageHint.usage()).toEqual(kickUsage(1));
  setText("/kick mel link spam");
  expect(usageHint.usage()).toEqual(kickUsage(1));
  setText("/kick mel");
  expect(usageHint.usage()).toEqual(kickUsage(1));
  setText("/kick");
  expect(usageHint.usage()).toBeUndefined();
  dispose();
});

it("hides after a send empties the composer and for plain words", () => {
  const { usageHint, setText, dispose } = hint(
    "/kick mel bye",
    answer("/kick mel bye", kickUsage(1)),
  );
  setText("");
  expect(usageHint.usage()).toBeUndefined();
  setText("hello");
  expect(usageHint.usage()).toBeUndefined();
  dispose();
});

it("ignores another buffer's answer and answers without a usage", () => {
  const { usageHint, setCompletion, dispose } = hint("/whois mel", {
    ...answer("/whois mel", kickUsage(0)),
    buffer_id: 8,
  });
  expect(usageHint.usage()).toBeUndefined();
  setCompletion(answer("/whois mel", null));
  expect(usageHint.usage()).toBeUndefined();
  dispose();
});

it("stays dismissed until the command changes or stops being a command", () => {
  const { usageHint, setText, setCompletion, dispose } = hint(
    "/kick mel",
    answer("/kick mel", kickUsage(0)),
  );
  usageHint.dismiss();
  expect(usageHint.usage()).toBeUndefined();

  setText("/kick mel spam");
  setCompletion(answer("/kick mel spam", kickUsage(1)));
  expect(usageHint.usage()).toBeUndefined();

  setText("/join #dev");
  setCompletion(answer("/join #dev", joinUsage));
  expect(usageHint.usage()).toEqual(joinUsage);

  usageHint.dismiss();
  setText("");
  setCompletion(answer("/join #dev", joinUsage));
  setText("/join #dev");
  expect(usageHint.usage()).toEqual(joinUsage);
  dispose();
});
