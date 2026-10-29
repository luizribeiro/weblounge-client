import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { Composer } from "./Composer";
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

it("cycles completion and restores drafts by buffer", () => {
  const [bufferId, setBufferId] = createSignal(2);
  render(() => (
    <Composer
      bufferId={bufferId()}
      bufferTitle="#rust"
      candidates={["alice", "alex"]}
      commandSpecs={[]}
      draftKey={`test:${bufferId()}`}
      onSend={() => {}}
    />
  ));
  const input = screen.getByRole("textbox");
  fireEvent.input(input, { target: { value: "al" } });
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input).toHaveValue("alice ");
  const listbox = screen.getByRole("listbox");
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(screen.getByRole("option", { name: "alice" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(input).toHaveAttribute(
    "aria-activedescendant",
    screen.getByRole("option", { name: "alice" }).id,
  );
  expect(input).toHaveAttribute("aria-controls", listbox.id);
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input).toHaveValue("alex ");
  setBufferId(3);
  expect(input).toHaveValue("");
  fireEvent.input(input, { target: { value: "other" } });
  setBufferId(2);
  expect(input).toHaveValue("alex ");
});

it("filters slash completion by the current token", () => {
  render(() => (
    <Composer
      bufferId={4}
      bufferTitle="#rust"
      candidates={["/join"]}
      draftKey="test:slash"
      onSend={() => {}}
    />
  ));
  const input = screen.getByRole("textbox");
  fireEvent.input(input, { target: { value: "/j" } });
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input).toHaveValue("/join ");
  expect(screen.getAllByRole("option")).toHaveLength(1);
});

it("hides completion when the engine returns no candidates", () => {
  render(() => (
    <Composer
      bufferId={9}
      bufferTitle="#rust"
      candidates={[]}
      draftKey="test:empty-completion"
      onSend={() => {}}
    />
  ));
  const input = screen.getByRole("textbox");
  fireEvent.input(input, { target: { value: "nobody" } });
  fireEvent.keyDown(input, { key: "Tab" });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(input).not.toHaveAttribute("aria-activedescendant");
});

it("requests engine candidates once and applies the asynchronous result", async () => {
  const [result, setResult] = createSignal<{
    prefix: string;
    candidates: readonly string[];
  }>();
  const request = vi.fn((value: string) => {
    setResult({ prefix: value, candidates: ["weblounge"] });
  });
  render(() => (
    <Composer
      bufferId={6}
      bufferTitle="#rust"
      candidatePrefix={result()?.prefix}
      candidates={result()?.candidates}
      draftKey="test:async-completion"
      onRequestCandidates={request}
      onSend={() => {}}
    />
  ));
  const input = screen.getByRole("textbox");
  fireEvent.input(input, { target: { value: "weblo" } });
  fireEvent.keyDown(input, { key: "Tab" });

  expect(request).toHaveBeenCalledWith("weblo");
  await waitFor(() => expect(input).toHaveValue("weblounge "));
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
