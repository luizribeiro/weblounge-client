import { render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

const scrollToDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo",
);

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions | number, y?: number) {
      this.scrollTop =
        typeof options === "number" ? (y ?? 0) : (options.top ?? 0);
      this.dispatchEvent(new Event("scroll"));
    },
  });
});

afterEach(() => {
  if (scrollToDescriptor === undefined) {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    return;
  }
  Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollToDescriptor);
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
    get: () => 34 + messages().length * 28,
  });
  Object.defineProperty(list, "clientHeight", {
    configurable: true,
    value: 5,
  });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  list.scrollTop = 40;
  list.dispatchEvent(new Event("scroll"));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  setMessages([{ ...message, id: 0, text: "older" }, message]);
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(list.scrollTop).toBe(68);
});

it("measures wrapped rows without overlap and preserves the live edge", async () => {
  const observers: ControlledResizeObserver[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class extends ControlledResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super(callback);
        observers.push(this);
      }
    },
  );
  const messages = [
    { ...message, id: 1, text: "short" },
    { ...message, id: 2, text: "x".repeat(2_000) },
    {
      ...message,
      id: 3,
      text: `https://example.com/${"unbroken".repeat(160)}`,
    },
  ];
  const { container } = render(() => <MessageList messages={messages} />);
  const list = container.querySelector<HTMLOListElement>("[data-message-list]");
  const spacer = container.querySelector<HTMLElement>("[class*='spacer']");
  if (list === null || spacer === null)
    throw new Error("message list is missing");
  let scrollTop = 0;
  let measuredScrollHeight: number | undefined;
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: {
      configurable: true,
      get: () => {
        if (measuredScrollHeight !== undefined) return measuredScrollHeight;
        const current =
          container.querySelector<HTMLElement>("[class*='spacer']");
        return Number.parseFloat(current?.style.height ?? "") || 0;
      },
    },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, list.scrollHeight - 300));
      },
    },
  });

  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  for (const observer of observers) observer.flushTarget(list, 300);
  const measuredElements = [
    ...list.querySelectorAll<HTMLLIElement>("li[data-index]"),
  ];
  measuredScrollHeight = measuredElements.reduce(
    (height, element) => height + measuredRowHeight(element),
    0,
  );
  for (const element of measuredElements)
    for (const observer of observers)
      observer.flushTarget(element, measuredRowHeight(element));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const boxes = [...container.querySelectorAll<HTMLElement>("li[data-index]")]
    .map((element) => {
      const start = translateY(element.style.transform);
      return { start, end: start + measuredRowHeight(element) };
    })
    .sort((left, right) => left.start - right.start);
  for (let index = 1; index < boxes.length; index += 1) {
    expect(boxes[index - 1]?.end).toBeLessThanOrEqual(boxes[index]?.start ?? 0);
  }
  expect(Math.max(...boxes.map((box) => box.end - box.start))).toBeGreaterThan(
    500,
  );
  expect(list.scrollHeight - list.scrollTop - list.clientHeight).toBe(0);
});

it("anchors visible content when an overscanned row above it grows", async () => {
  const observers: ControlledResizeObserver[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class extends ControlledResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super(callback);
        observers.push(this);
      }
    },
  );
  const messages = Array.from({ length: 80 }, (_, index) => ({
    ...message,
    id: index + 1,
    text: `message ${index + 1}`,
  }));
  const { container } = render(() => <MessageList messages={messages} />);
  const list = container.querySelector<HTMLOListElement>("[data-message-list]");
  const spacer = container.querySelector<HTMLElement>("[class*='spacer']");
  if (list === null || spacer === null)
    throw new Error("message list is missing");
  let scrollTop = 0;
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 120 },
    scrollHeight: {
      configurable: true,
      get: () => Number.parseFloat(spacer.style.height) || 0,
    },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, list.scrollHeight - 120));
      },
    },
    scrollTo: {
      configurable: true,
      value: (options: ScrollToOptions) => {
        if (typeof options.top === "number") list.scrollTop = options.top;
      },
    },
  });

  await new Promise<void>((resolve) => queueMicrotask(resolve));
  for (const observer of observers) observer.flushTarget(list, 120);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  list.scrollTop = 600;
  list.dispatchEvent(new Event("scroll"));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  const rendered = [
    ...container.querySelectorAll<HTMLLIElement>("li[data-index]"),
  ]
    .map((element) => ({
      element,
      start: translateY(element.style.transform),
    }))
    .sort((left, right) => left.start - right.start);
  const above = rendered.find(({ start }) => start + 28 < list.scrollTop);
  const anchor = rendered.find(({ start }) => start >= list.scrollTop);
  if (above === undefined || anchor === undefined)
    throw new Error("expected rows around the viewport");
  const anchorKey = anchor.element.dataset.rowKey;
  const relativeTop = anchor.start - list.scrollTop;

  for (const observer of observers) observer.flushTarget(above.element, 228);
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  const movedAnchor = container.querySelector<HTMLLIElement>(
    `li[data-row-key="${anchorKey}"]`,
  );
  if (movedAnchor === null) throw new Error("visible anchor row is missing");
  expect(translateY(movedAnchor.style.transform) - list.scrollTop).toBe(
    relativeTop,
  );
}, 15_000);

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
        {
          ...message,
          id: 4,
          author: "mel",
          authorship: "own",
          delivery: "received",
          kind: "notice",
          mentioned: false,
          server_time_ms: Date.UTC(2026, 9, 28, 12),
          text: "A quiet room",
          received_at_ms: 5,
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
  expect(screen.getByText("A quiet room")).toBeInTheDocument();
  expect(
    screen.getByText(/set by mel/).closest("[data-notice-row]"),
  ).toHaveTextContent("Topic: A quiet room");
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
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  list.scrollTop = 0;
  list.dispatchEvent(new Event("scroll"));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  setMessages([
    ...initial,
    { ...message, id: 51, text: "arrived away", received_at_ms: 51 },
  ]);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(screen.getByRole("button", { name: /1 new message/ })).toBeVisible();
  expect(list.scrollTop).toBe(0);
}, 15_000);

it("keeps following through a transient one-row render gap", async () => {
  const [messages, setMessages] = createSignal([message]);
  const { container } = render(() => <MessageList messages={messages()} />);
  const list = container.querySelector<HTMLOListElement>("[data-message-list]");
  if (list === null) throw new Error("message list is missing");
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 1_300 },
  });
  setMessages([
    message,
    { ...message, id: 2, text: "burst arrival", received_at_ms: 2 },
  ]);
  list.scrollTop = 784;
  list.dispatchEvent(new Event("scroll"));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(
    screen.queryByRole("button", { name: /new message/ }),
  ).not.toBeInTheDocument();
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

class ControlledResizeObserver {
  readonly #callback: ResizeObserverCallback;
  readonly #targets = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
  }

  observe(target: Element): void {
    this.#targets.add(target);
  }

  unobserve(target: Element): void {
    this.#targets.delete(target);
  }

  disconnect(): void {
    this.#targets.clear();
  }

  flushTarget(target: Element, blockSize: number): void {
    if (!this.#targets.has(target)) return;
    this.#callback(
      [
        {
          target,
          borderBoxSize: [{ blockSize, inlineSize: 800 } as ResizeObserverSize],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
}

function measuredRowHeight(target: Element): number {
  const messageRow = target.querySelector("[data-message-row]");
  if (messageRow === null) return 34;
  return Math.max(
    26,
    Math.ceil((messageRow.textContent?.length ?? 0) / 50) * 20,
  );
}

function translateY(transform: string): number {
  const match = /translateY\(([-\d.]+)px\)/.exec(transform);
  return Number(match?.[1] ?? 0);
}
