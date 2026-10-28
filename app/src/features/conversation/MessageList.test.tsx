import { render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import type { MessageProjection } from "../../engine/protocol";
import { MessageList } from "./MessageList";

const message: MessageProjection = {
  id: 1,
  author: "alice",
  text: "hello weblounge",
  authorship: "other",
  nick_color_index: 7,
  mentioned: true,
  delivery: "failed",
  local_send_id: null,
  server_ids: [],
  server_time_ms: null,
  received_at_ms: 1,
};

it("renders mention, nick colour, and failed delivery presentation", () => {
  render(() => <MessageList messages={[message]} />);

  const row = screen.getByText("hello weblounge").closest("[data-message-row]");
  expect(row).toHaveAttribute("data-delivery", "failed");
  expect(screen.getByText("alice")).toHaveStyle({
    color: "var(--wl-nick-1)",
  });
  expect(screen.getByText("Failed")).toBeInTheDocument();
});

it("anchors the viewport when history rows are prepended", async () => {
  const [messages, setMessages] = createSignal([message]);
  const { container } = render(() => <MessageList messages={messages()} />);
  const list = container.querySelector<HTMLOListElement>("[data-message-list]");
  if (list === null) throw new Error("message list is missing");
  Object.defineProperty(list, "scrollHeight", {
    configurable: true,
    get: () => messages().length * 20,
  });
  list.scrollTop = 10;
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  setMessages([{ ...message, id: 0, text: "older" }, message]);
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(list.scrollTop).toBe(30);
});
