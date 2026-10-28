import { fireEvent, render, screen } from "@solidjs/testing-library";
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
