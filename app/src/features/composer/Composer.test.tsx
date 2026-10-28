import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { Composer } from "./Composer";

it("sends on Enter, keeps Shift+Enter, and ignores composition", () => {
  const onSend = vi.fn();
  render(() => <Composer bufferId={1} bufferTitle="#lounge" onSend={onSend} />);
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
      onSend={() => {}}
    />
  ));
  const input = screen.getByRole("textbox");
  fireEvent.input(input, { target: { value: "al" } });
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input).toHaveValue("alice ");
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
      candidates={["/join", "/msg"]}
      onSend={() => {}}
    />
  ));
  const input = screen.getByRole("textbox");
  fireEvent.input(input, { target: { value: "/j" } });
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input).toHaveValue("/join ");
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
      onSelectLast={onSelectLast}
      onSend={() => {}}
    />
  ));
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowUp" });
  expect(onSelectLast).toHaveBeenCalledOnce();
});

it("grows the textarea with multiline content", async () => {
  render(() => <Composer bufferId={7} bufferTitle="#rust" onSend={() => {}} />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  Object.defineProperty(input, "scrollHeight", { value: 84 });

  fireEvent.input(input, { target: { value: "first\nsecond\nthird" } });
  await Promise.resolve();

  expect(input.style.height).toBe("84px");
});
