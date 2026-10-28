import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { SimpleComposer } from "./SimpleComposer";

it("sends a nonempty message and clears the temporary input", () => {
  const onSend = vi.fn();
  render(() => <SimpleComposer bufferTitle="#lounge" onSend={onSend} />);
  const input = screen.getByRole("textbox", { name: "Message #lounge" });

  fireEvent.input(input, { target: { value: " hello " } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);

  expect(onSend).toHaveBeenCalledWith("hello");
  expect(input).toHaveValue("");
});
