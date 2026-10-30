import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type {
  CompletionCandidate,
  CompletionResult,
} from "../../engine/protocol";
import { Composer, replacementFor } from "./Composer";
import { readDraft } from "./draft-storage";

const identify = {
  name: "identify",
  aliases: ["id"],
  arguments: [],
  usage: "cmd.identify.usage",
  description: "cmd.identify.description",
  requirements: [{ type: "connected" as const }],
  permission: "anyone" as const,
  surfaces: ["slash" as const],
  confirm: "none" as const,
  secret_arguments: true,
};

const quit = {
  ...identify,
  name: "quit",
  aliases: ["exit"],
  confirm: "always" as const,
  confirmation_prompt: "cmd.quit.confirmation_prompt",
  confirmation_action: "cmd.quit.confirmation_action",
  secret_arguments: false,
};

const person = (nick: string): CompletionCandidate => ({
  type: "person",
  nick,
  nick_color_index: 1,
  away: false,
  bot: false,
});

function completion(
  input: string,
  candidates: readonly CompletionCandidate[],
  replaceStart = 0,
  argumentHint: string | null = null,
): CompletionResult {
  return {
    type: "completion_result",
    command_id: `complete:${input}`,
    buffer_id: 2,
    input,
    trigger: "person",
    replace_start: replaceStart,
    replace_end: input.length,
    argument_hint: argumentHint,
    candidates: [...candidates],
  };
}

it("uses IRC insertion rules for mentions and plain Tab completion", () => {
  const candidate = person("ana");
  expect(
    replacementFor(candidate, {
      input: "@an",
      replace_start: 0,
      argument_hint: null,
    }),
  ).toBe("ana: ");
  expect(
    replacementFor(candidate, {
      input: "hello @an",
      replace_start: 6,
      argument_hint: null,
    }),
  ).toBe("ana");
  expect(
    replacementFor(candidate, {
      input: "an",
      replace_start: 0,
      argument_hint: null,
    }),
  ).toBe("ana ");
});

it("sends on Enter, keeps Shift+Enter, and ignores composition", () => {
  const onSend = vi.fn();
  render(() => (
    <Composer
      bufferId={1}
      bufferTitle="#lounge"
      draftKey="test:#lounge"
      onSend={onSend}
    />
  ));
  const input = screen.getByRole("textbox");
  fireEvent.input(input, { target: { value: "hello" } });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onSend).toHaveBeenCalledWith("hello");
});

it("confirms always-policy commands typed by name or alias", async () => {
  const onSend = vi.fn();
  render(() => (
    <Composer
      bufferId={1}
      bufferTitle="#lounge"
      commandSpecs={[quit]}
      draftKey="test:confirm"
      onSend={onSend}
    />
  ));
  const input = screen.getByRole("textbox");
  fireEvent.input(input, { target: { value: "  /EXIT later" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await Promise.resolve();

  expect(onSend).not.toHaveBeenCalled();
  expect(
    screen.getByRole("alertdialog", { name: "Confirm /quit" }),
  ).toBeVisible();
  expect(screen.getByText("Disconnect from this network?")).toBeVisible();
  expect(screen.getByRole("button", { name: "Disconnect" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(onSend).toHaveBeenCalledWith("  /EXIT later");
});

it("cancels inline confirmation with Escape and keeps the draft", async () => {
  const onSend = vi.fn();
  render(() => (
    <Composer
      bufferId={1}
      bufferTitle="#lounge"
      commandSpecs={[quit]}
      draftKey="test:cancel-confirm"
      onSend={onSend}
    />
  ));
  const input = screen.getByRole("textbox");
  fireEvent.input(input, { target: { value: "/quit" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
  await Promise.resolve();

  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(input).toHaveValue("/quit");
  expect(input).toHaveFocus();
  expect(onSend).not.toHaveBeenCalled();
});

it("navigates suggestions, inserts a mention, and restores drafts", () => {
  const [bufferId, setBufferId] = createSignal(2);
  const [result, setResult] = createSignal<CompletionResult>();
  render(() => (
    <Composer
      bufferId={bufferId()}
      bufferTitle="#rust"
      completion={result()}
      commandSpecs={[]}
      draftKey={`test:${bufferId()}`}
      onSend={() => {}}
    />
  ));
  const input = screen.getByRole("textbox");
  fireEvent.input(input, { target: { value: "al" } });
  setResult(completion("al", [person("alice"), person("alex")]));
  const listbox = screen.getByRole("listbox");
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(screen.getByRole("option", { name: /alice/u })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("combobox")).toHaveAttribute(
    "aria-activedescendant",
    screen.getByRole("option", { name: /alice/u }).id,
  );
  expect(screen.getByRole("combobox")).toHaveAttribute(
    "aria-controls",
    listbox.id,
  );
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input).toHaveValue("alex ");
  setBufferId(3);
  expect(input).toHaveValue("");
  fireEvent.input(input, { target: { value: "other" } });
  setBufferId(2);
  expect(input).toHaveValue("alex ");
});

it("accepts command suggestions and requests their argument context", async () => {
  const request = vi.fn();
  render(() => (
    <Composer
      bufferId={4}
      bufferTitle="#rust"
      completion={{
        ...completion("/jo", [
          {
            type: "command",
            name: "join",
            usage: "cmd.join.usage",
            description: "cmd.join.description",
          },
        ]),
        buffer_id: 4,
        trigger: "command",
      }}
      draftKey="test:slash"
      onRequestCandidates={request}
      onSend={() => {}}
    />
  ));
  const input = screen.getByRole("textbox");
  fireEvent.input(input, { target: { value: "/jo" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input).toHaveValue("/join ");
  await Promise.resolve();
  expect(request).toHaveBeenLastCalledWith("/join ", 6, false);
});

it("hides completion when the engine returns no candidates", () => {
  render(() => (
    <Composer
      bufferId={9}
      bufferTitle="#rust"
      completion={{ ...completion("nobody", []), buffer_id: 9 }}
      draftKey="test:empty-completion"
      onSend={() => {}}
    />
  ));
  const input = screen.getByRole("textbox");
  fireEvent.input(input, { target: { value: "nobody" } });
  fireEvent.keyDown(input, { key: "Tab" });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(screen.getByRole("combobox")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

it("keeps previous suggestions visible while the next result is pending", () => {
  const [result, setResult] = createSignal<CompletionResult>();
  const join: CompletionCandidate = {
    type: "command",
    name: "join",
    usage: "cmd.join.usage",
    description: "cmd.join.description",
  };
  const me: CompletionCandidate = {
    type: "command",
    name: "me",
    usage: "cmd.me.usage",
    description: "cmd.me.description",
  };
  render(() => (
    <Composer
      bufferId={9}
      bufferTitle="#rust"
      completion={result()}
      draftKey="test:stable-completion"
      onSend={() => {}}
    />
  ));
  const input = screen.getByRole("textbox");
  fireEvent.input(input, { target: { value: "/" } });
  setResult({
    ...completion("/", [join, me]),
    buffer_id: 9,
    trigger: "command",
  });
  expect(screen.getAllByRole("option")).toHaveLength(2);
  const joinRow = screen.getByRole("option", { name: /\/join/u });

  fireEvent.input(input, { target: { value: "/j" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option", { name: /\/join/u })).toBe(joinRow);
  expect(screen.getByRole("listbox").parentElement).toHaveAttribute(
    "data-completion-input",
    "/",
  );

  setResult({
    ...completion("/j", [join]),
    buffer_id: 9,
    trigger: "command",
  });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option", { name: /\/join/u })).toBe(joinRow);
  expect(screen.getByRole("listbox").parentElement).toHaveAttribute(
    "data-completion-input",
    "/j",
  );
});

it("requests as input changes, accepts Tab, and ignores IME composition", async () => {
  const [result, setResult] = createSignal<CompletionResult>();
  const request = vi.fn((value: string, _cursor: number, explicit: boolean) => {
    setResult({
      ...completion(value, [person("weblounge")]),
      buffer_id: 6,
      replace_start: value.indexOf("weblo"),
    });
    expect(explicit).toBe(false);
  });
  render(() => (
    <Composer
      bufferId={6}
      bufferTitle="#rust"
      completion={result()}
      draftKey="test:async-completion"
      onRequestCandidates={request}
      onSend={() => {}}
    />
  ));
  const input = screen.getByRole("textbox");
  fireEvent.input(input, { target: { value: "hello weblo" } });
  await waitFor(() => expect(screen.getByRole("listbox")).toBeVisible());
  fireEvent.keyDown(input, { key: "Tab" });

  expect(request).toHaveBeenCalledWith("hello weblo", 11, false);
  await waitFor(() => expect(input).toHaveValue("hello weblounge "));
  request.mockClear();
  fireEvent.compositionStart(input);
  fireEvent.input(input, { target: { value: "@あ" } });
  expect(request).not.toHaveBeenCalled();
});

it("routes Up from an empty composer to message navigation", () => {
  const onSelectLast = vi.fn();
  render(() => (
    <Composer
      bufferId={5}
      bufferTitle="#rust"
      draftKey="test:select-last"
      onSelectLast={onSelectLast}
      onSend={() => {}}
    />
  ));
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowUp" });
  expect(onSelectLast).toHaveBeenCalledOnce();
});

it("grows the textarea with multiline content", async () => {
  render(() => (
    <Composer
      bufferId={7}
      bufferTitle="#rust"
      draftKey="test:multiline"
      onSend={() => {}}
    />
  ));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  Object.defineProperty(input, "scrollHeight", { value: 84 });

  fireEvent.input(input, { target: { value: "first\nsecond\nthird" } });
  await Promise.resolve();

  expect(input.style.height).toBe("84px");
});

it("keeps a draft when the engine rejects submission", async () => {
  render(() => (
    <Composer
      bufferId={8}
      bufferTitle="#rust"
      commandSpecs={[]}
      draftKey="test:rejected"
      onSend={() => Promise.resolve(false)}
    />
  ));
  const input = screen.getByRole("textbox");
  fireEvent.input(input, { target: { value: "/join #banned" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await Promise.resolve();

  expect(input).toHaveValue("/join #banned");
  expect(readDraft("test:rejected")).toBe("/join #banned");
});

it("does not persist secret command arguments", () => {
  render(() => (
    <Composer
      bufferId={1}
      bufferTitle="#lounge"
      commandSpecs={[identify]}
      draftKey="test:secret"
      onSend={() => true}
    />
  ));

  fireEvent.input(screen.getByRole("textbox"), {
    target: { value: "/id hunter2" },
  });

  expect(readDraft("test:secret")).toBe("");
});

it("restores a non-autojoined buffer draft after reload with a new buffer id", () => {
  const first = render(() => (
    <Composer
      bufferId={40}
      bufferTitle="#later"
      commandSpecs={[]}
      draftKey="5:Local:rfc1459:#later"
      onSend={() => {}}
    />
  ));
  fireEvent.input(screen.getByRole("textbox"), {
    target: { value: "survives reload" },
  });
  first.unmount();

  render(() => (
    <Composer
      bufferId={93}
      bufferTitle="#later"
      commandSpecs={[]}
      draftKey="5:Local:rfc1459:#later"
      onSend={() => {}}
    />
  ));

  expect(screen.getByRole("textbox")).toHaveValue("survives reload");
});

it("persists nothing until command specs arrive", () => {
  render(() => (
    <Composer
      bufferId={1}
      bufferTitle="#lounge"
      draftKey="test:pending-specs"
      onSend={() => true}
    />
  ));

  fireEvent.input(screen.getByRole("textbox"), {
    target: { value: "could be secret" },
  });

  expect(readDraft("test:pending-specs")).toBe("");
});

it("clears a draft when arriving specs classify it as secret", () => {
  const [specs, setSpecs] = createSignal<readonly (typeof identify)[]>([]);
  render(() => (
    <Composer
      bufferId={1}
      bufferTitle="#lounge"
      commandSpecs={specs()}
      draftKey="test:late-secret"
      onSend={() => true}
    />
  ));
  fireEvent.input(screen.getByRole("textbox"), {
    target: { value: "/id hunter2" },
  });
  expect(readDraft("test:late-secret")).toBe("/id hunter2");

  setSpecs([identify]);

  expect(readDraft("test:late-secret")).toBe("");
});
