import { fireEvent, render, screen } from "@solidjs/testing-library";
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
  const view = render(() => (
    <Composer
      bufferId={2}
      bufferTitle="#rust"
      candidates={["alice", "alex"]}
      onSend={() => {}}
    />
  ));
  const input = screen.getByRole("textbox");
  fireEvent.input(input, { target: { value: "al" } });
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input).toHaveValue("alice ");
  view.unmount();
  render(() => <Composer bufferId={2} bufferTitle="#rust" onSend={() => {}} />);
  expect(screen.getByRole("textbox")).toHaveValue("alice ");
});
