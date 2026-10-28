import { render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type {
  MembershipProjection,
  MessageProjection,
} from "../../engine/protocol";
import { MessageList, type MessageListController } from "./MessageList";
import { createNickLookup } from "./nick-lookup";

vi.mock("./nick-lookup", async (importOriginal) => {
  const original = await importOriginal<typeof import("./nick-lookup")>();
  return { ...original, createNickLookup: vi.fn(original.createNickLookup) };
});

const message: MessageProjection = {
  id: 1,
  author: "alice",
  text: "hello weblounge",
  kind: "text",
  bot: false,
  mode_symbol: null,
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

it("renders action, own, pending, bot, mode, divider, New, and membership variants", async () => {
  const membership: MembershipProjection = {
    id: 20,
    kind: "joined",
    nicks: ["mel", "rafa", "cyd"],
    server_time_ms: 2,
    received_at_ms: 2,
  };
  render(() => (
    <MessageList
      memberships={[membership]}
      messages={[
        {
          ...message,
          id: 1,
          text: "first",
          mentioned: false,
          delivery: "received",
        },
        {
          ...message,
          id: 2,
          author: "weblounge",
          authorship: "own",
          bot: true,
          delivery: "optimistic",
          kind: "action",
          mentioned: false,
          mode_symbol: "@",
          text: "waves",
          received_at_ms: 3,
        },
        {
          ...message,
          id: 3,
          author: "concierge",
          bot: true,
          delivery: "received",
          mentioned: false,
          mode_symbol: "@",
          text: "welcome",
          received_at_ms: 4,
        },
      ]}
      readThrough={1}
    />
  ));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(screen.getByText("New")).toBeInTheDocument();
  expect(screen.getByText("→ mel, rafa and cyd joined")).toBeInTheDocument();
  expect(screen.getByText("waves").closest("[data-message-row]")).toHaveClass(
    /action/,
  );
  expect(screen.getByText("Sending…")).toBeInTheDocument();
  expect(screen.getByText("BOT")).toBeInTheDocument();
  expect(screen.getByText("@")).toBeInTheDocument();
});

it("keeps the New boundary frozen while the live marker advances", async () => {
  const [readThrough, setReadThrough] = createSignal<number | null>(1);
  const { container } = render(() => (
    <MessageList
      bufferId={2}
      messages={[message, { ...message, id: 2, text: "newer" }]}
      readThrough={readThrough()}
    />
  ));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(container.querySelector("[data-new-line]")).not.toBeNull();

  setReadThrough(2);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(container.querySelector("[data-new-line]")).not.toBeNull();
});

it("keeps a bounded DOM for ten thousand rows", async () => {
  const messages = Array.from({ length: 10_000 }, (_, index) => ({
    ...message,
    id: index + 1,
    text: `message ${index + 1}`,
    received_at_ms: index + 1,
  }));
  const { container } = render(() => <MessageList messages={messages} />);
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(container.querySelectorAll("[data-message-row]").length).toBeLessThan(
    80,
  );
});

it("builds one distinct-nick lookup for all rendered rows", () => {
  vi.mocked(createNickLookup).mockClear();
  render(() => (
    <MessageList
      messages={[
        message,
        { ...message, id: 2, author: "bob", text: "hello alice" },
        { ...message, id: 3, text: "hello bob" },
      ]}
    />
  ));

  expect(createNickLookup).toHaveBeenCalledOnce();
  expect(createNickLookup).toHaveReturnedWith(
    new Map([
      ["alice", message],
      ["bob", { ...message, id: 2, author: "bob", text: "hello alice" }],
    ]),
  );
});

it("offers new messages without moving a scrolled-away viewport", async () => {
  const initial = Array.from({ length: 50 }, (_, index) => ({
    ...message,
    id: index + 1,
    text: `message ${index + 1}`,
    received_at_ms: index + 1,
  }));
  const [messages, setMessages] = createSignal(initial);
  const { container } = render(() => <MessageList messages={messages()} />);
  const list = container.querySelector<HTMLOListElement>("[data-message-list]");
  if (list === null) throw new Error("message list is missing");
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 1_300 },
  });
  list.scrollTop = 0;
  list.dispatchEvent(new Event("scroll"));

  setMessages([
    ...initial,
    { ...message, id: 51, text: "arrived away", received_at_ms: 51 },
  ]);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(screen.getByRole("button", { name: /1 new message/ })).toBeVisible();
  expect(list.scrollTop).toBe(0);
});

it("keeps the full nick accessible when its visual start truncates", () => {
  render(() => (
    <MessageList
      messages={[{ ...message, author: "an-extremely-long-nickname" }]}
    />
  ));

  expect(screen.getByTitle("an-extremely-long-nickname")).toHaveTextContent(
    "an-extremely-long-nickname",
  );
});

it("selects the latest own message for empty-composer Up", async () => {
  let controller: MessageListController | undefined;
  const { container } = render(() => (
    <MessageList
      messages={[message, { ...message, id: 2, authorship: "own" }]}
      registerController={(value) => {
        controller = value;
      }}
    />
  ));
  controller?.selectLastOwn();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(container.querySelector('[data-selected="true"]')).not.toBeNull();
  expect(screen.getByRole("list", { name: "Messages" })).toHaveFocus();
});
