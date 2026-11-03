import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  MembershipProjection,
  MessageProjection,
} from "../../engine/protocol";
import { composerGeometryChangeEvent } from "../composer/geometry";
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
const fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");

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
  vi.restoreAllMocks();
  if (scrollToDescriptor === undefined)
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  else
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollTo",
      scrollToDescriptor,
    );
  if (fontsDescriptor === undefined) Reflect.deleteProperty(document, "fonts");
  else Object.defineProperty(document, "fonts", fontsDescriptor);
});

const message: MessageProjection = {
  id: 1,
  author: "alice",
  text: "hello weblounge",
  kind: "text",
  bot: false,
  authorship: "other",
  nick_color_index: 7,
  highlighted: true,
  delivery: "failed",
  local_send_id: null,
  server_ids: [],
  server_time_ms: null,
  received_at_ms: 1,
};

it("renders highlight, nick colour, and failed delivery presentation", () => {
  render(() => <MessageList messages={[message]} />);

  const row = screen.getByText("hello weblounge").closest("[data-message-row]");
  expect(row).toHaveAttribute("data-delivery", "failed");
  expect(row?.className).toContain("highlighted");
  expect(screen.getByText("alice")).toHaveStyle({
    color: "var(--wl-nick-1)",
  });
  expect(screen.getByText("Failed")).toBeInTheDocument();
});

it("marks a direct row whose sender identity is unverified", () => {
  render(() => (
    <MessageList messages={[{ ...message, unverified_sender: true }]} />
  ));

  const row = screen.getByText("hello weblounge").closest("[data-message-row]");
  expect(row).toHaveAttribute("data-unverified-sender", "true");
  expect(screen.getByLabelText("Unverified sender")).toBeVisible();
});

it("opens non-own authors and mentions through the same nickname action", () => {
  const openDirect = vi.fn();
  render(() => (
    <MessageList
      messages={[
        { ...message, text: "hello bob and weblounge" },
        {
          ...message,
          id: 2,
          author: "bob",
          text: "hello",
          highlighted: false,
        },
        {
          ...message,
          id: 3,
          author: "weblounge",
          authorship: "own",
          text: "hello",
          highlighted: false,
        },
      ]}
      onOpenDirect={openDirect}
    />
  ));

  fireEvent.click(
    screen.getAllByRole("button", {
      name: "Open direct message with alice",
    })[0] as HTMLElement,
  );
  fireEvent.click(
    screen.getAllByRole("button", {
      name: "Open direct message with bob",
    })[0] as HTMLElement,
  );
  expect(openDirect.mock.calls).toEqual([["alice"], ["bob"]]);
  expect(
    screen.queryByRole("button", {
      name: "Open direct message with weblounge",
    }),
  ).toBeNull();
});

it("re-anchors the live edge synchronously with app geometry", () => {
  render(() => <MessageList messages={[message]} />);
  const list = screen.getByRole("list", { name: "Messages" });
  const scrollTo = vi.spyOn(list, "scrollTo");
  const unrelatedOwner = document.createElement("div");

  window.dispatchEvent(
    new CustomEvent("weblounge:app-geometry-change", {
      detail: {
        geometry: { keyboard: "open", height: 500 },
        owner: document.body,
      },
    }),
  );

  expect(scrollTo).toHaveBeenCalledOnce();

  window.dispatchEvent(
    new CustomEvent("weblounge:app-geometry-change", {
      detail: {
        geometry: { keyboard: "open", height: 500 },
        owner: unrelatedOwner,
      },
    }),
  );

  expect(scrollTo).toHaveBeenCalledOnce();
});

it("anchors composer height changes before viewport resize delivery", async () => {
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
  render(() => (
    <div>
      <MessageList
        messages={Array.from({ length: 30 }, (_, index) => ({
          ...message,
          id: index + 1,
        }))}
      />
      <div data-composer="true">
        <textarea />
      </div>
    </div>
  ));
  const list = screen.getByRole("list", { name: "Messages" });
  const input = screen.getByRole("textbox");
  let listHeight = 600;
  Object.defineProperty(list, "clientHeight", {
    configurable: true,
    get: () => listHeight,
  });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  for (const observer of observers) observer.flushTarget(list, 600);
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  list.scrollTop = 200;
  const scrollTo = vi.spyOn(list, "scrollTo");
  input.style.height = "80px";
  listHeight = 560;
  input.dispatchEvent(
    new Event(composerGeometryChangeEvent, { bubbles: true }),
  );
  expect(scrollTo).toHaveBeenCalledOnce();

  scrollTo.mockClear();
  for (const observer of observers) observer.flushTarget(list, 560);
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(scrollTo).not.toHaveBeenCalled();
});

it("keeps the live edge through viewport resizes", async () => {
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
  render(() => (
    <MessageList
      messages={Array.from({ length: 30 }, (_, index) => ({
        ...message,
        id: index + 1,
      }))}
    />
  ));
  const list = screen.getByRole("list", { name: "Messages" });
  let listHeight = 600;
  let listWidth = 800;
  Object.defineProperties(list, {
    clientHeight: { configurable: true, get: () => listHeight },
    clientWidth: { configurable: true, get: () => listWidth },
  });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  for (const observer of observers) observer.flushTarget(list, 600);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  list.scrollTop = 200;
  const scrollTo = vi.spyOn(list, "scrollTo");

  listHeight = 560;
  for (const observer of observers) observer.flushTarget(list, 560);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(scrollTo).toHaveBeenCalledOnce();

  scrollTo.mockClear();
  listWidth = 402;
  for (const observer of observers) observer.flushTarget(list, 560);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(scrollTo).toHaveBeenCalledOnce();
});

it("offers Retry for a failed local send", () => {
  const retry = vi.fn();
  render(() => (
    <MessageList
      messages={[{ ...message, local_send_id: 7 }]}
      onRetry={retry}
    />
  ));

  fireEvent.click(screen.getByRole("button", { name: "Failed · Retry" }));
  expect(retry).toHaveBeenCalledWith(7);
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
  fireEvent.wheel(list, { deltaY: -100 });
  list.scrollTop = 40;
  list.dispatchEvent(new Event("scroll"));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  setMessages([{ ...message, id: 0, text: "older" }, message]);
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(list.scrollTop).toBe(68);
});

it("measures wrapped rows without overlap and preserves the live edge", async () => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches("li[data-index]") ? measuredRowHeight(this) : 0;
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
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: {
      configurable: true,
      get: () => Number.parseFloat(spacer.style.height) || 0,
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

it("remeasures rows after fonts finish loading", async () => {
  const fonts = Object.assign(new EventTarget(), { ready: Promise.resolve() });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: fonts as unknown as FontFaceSet,
  });
  let messageHeight = 28;
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.querySelector("[data-message-row]") === null
        ? 34
        : messageHeight;
    },
  );
  const { container } = render(() => (
    <MessageList messages={[message, { ...message, id: 2 }]} />
  ));
  const list = container.querySelector<HTMLOListElement>("[data-message-list]");
  if (list === null) throw new Error("message list is missing");
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const secondMessage = () =>
    container.querySelector<HTMLLIElement>('[data-row-key="message-2"]');
  const initialPosition = translateY(secondMessage()?.style.transform ?? "");

  messageHeight = 90;
  fonts.dispatchEvent(new Event("loadingdone"));
  expect(translateY(secondMessage()?.style.transform ?? "")).not.toBe(
    initialPosition,
  );
  expect(translateY(secondMessage()?.style.transform ?? "")).toBe(656);
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
  fireEvent.wheel(list, { deltaY: -100 });
  list.scrollTop = 600;
  list.dispatchEvent(new Event("scroll"));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

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

it("renders action, own, pending, bot, divider, New, and membership variants", async () => {
  const membership: MembershipProjection = {
    type: "change",
    id: 20,
    kind: "joined",
    nicks: ["mel", "rafa", "cyd"],
    server_time_ms: 2,
    received_at_ms: 2,
  };
  const kicked: MembershipProjection = {
    type: "kicked",
    id: 21,
    actor: "operator",
    reason: "too loud",
    server_time_ms: 6,
    received_at_ms: 6,
  };
  const rejoin = vi.fn();
  render(() => (
    <MessageList
      memberships={[membership, kicked]}
      messages={[
        {
          ...message,
          id: 1,
          text: "first",
          highlighted: false,
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
          highlighted: false,
          text: "waves",
          received_at_ms: 3,
        },
        {
          ...message,
          id: 3,
          author: "concierge",
          bot: true,
          delivery: "received",
          highlighted: false,
          text: "welcome",
          received_at_ms: 4,
        },
      ]}
      onRejoin={rejoin}
      readAtMs={1}
    />
  ));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(screen.getByText("New")).toBeInTheDocument();
  expect(screen.getByText("→ mel, rafa and cyd joined")).toBeInTheDocument();
  expect(screen.getByText(/operator kicked you: too loud/u)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Rejoin" }));
  expect(rejoin).toHaveBeenCalledOnce();
  expect(screen.getByText("waves").closest("[data-message-row]")).toHaveClass(
    /action/,
  );
  expect(screen.getByText("Sending…")).toBeInTheDocument();
  expect(screen.getByText("BOT")).toBeInTheDocument();
});

it("renders topic notices with their setter and time", async () => {
  const setAt = Date.UTC(2026, 9, 28, 12);
  render(() => (
    <MessageList
      messages={[
        {
          ...message,
          author: "",
          authorship: "own",
          delivery: "received",
          highlighted: false,
          kind: {
            notice: { type: "topic", setter: "mel", set_at: setAt },
          },
          server_time_ms: null,
          text: "A quiet room",
        },
      ]}
    />
  ));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  const row = screen.getByText(/set by mel/).closest("[data-notice-row]");
  expect(row).toHaveAttribute("data-notice-kind", "topic");
  expect(row).toHaveTextContent("Topic: A quiet room");
  expect(row?.querySelector("time")).toHaveAttribute(
    "datetime",
    new Date(setAt).toISOString(),
  );
});

it("renders info notices as plain muted event rows", async () => {
  render(() => (
    <MessageList
      messages={[
        {
          ...message,
          author: "",
          authorship: "own",
          delivery: "received",
          highlighted: false,
          kind: { notice: { type: "info" } },
          text: "weblounge test build",
        },
      ]}
    />
  ));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  const row = screen
    .getByText("weblounge test build")
    .closest("[data-notice-row]");
  expect(row).toHaveAttribute("data-notice-kind", "info");
  expect(row).toHaveTextContent("weblounge test build");
  expect(row).not.toHaveTextContent("Topic:");
  expect(row).not.toHaveTextContent("set by");
});

it("keeps the New boundary frozen while the live marker advances", async () => {
  const [readAtMs, setReadAtMs] = createSignal<number | null>(1);
  const { container } = render(() => (
    <MessageList
      bufferId={2}
      messages={[
        message,
        { ...message, id: 2, text: "newer", received_at_ms: 2 },
      ]}
      readAtMs={readAtMs()}
    />
  ));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(container.querySelector("[data-new-line]")).not.toBeNull();

  setReadAtMs(2);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(container.querySelector("[data-new-line]")).not.toBeNull();
});

it("hides the New boundary when the read marker row is unknown", async () => {
  const { container } = render(() => (
    <MessageList
      messages={[
        { ...message, id: 10, text: "oldest retained" },
        { ...message, id: 11, text: "newest retained" },
      ]}
      readAtMs={null}
    />
  ));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(container.querySelector("[data-new-line]")).toBeNull();
});

it("shows New at the top when a known marker predates the loaded window", async () => {
  const { container } = render(() => (
    <MessageList
      messages={[
        { ...message, id: 10, text: "oldest unread", received_at_ms: 10 },
        { ...message, id: 11, text: "newest unread", received_at_ms: 11 },
      ]}
      readAtMs={9}
    />
  ));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  const newLine = container.querySelector("[data-new-line]");
  expect(newLine?.closest("li")?.nextElementSibling).toHaveTextContent(
    "oldest unread",
  );
});

it("places New by timeline order after older history is prepended", async () => {
  const { container } = render(() => (
    <MessageList
      messages={[
        { ...message, id: 4, text: "loaded later", received_at_ms: 1 },
        { ...message, id: 3, text: "read row", received_at_ms: 2 },
        { ...message, id: 2, text: "unread row", received_at_ms: 3 },
      ]}
      readAtMs={2}
    />
  ));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  const newLine = container.querySelector("[data-new-line]");
  expect(newLine?.closest("li")?.nextElementSibling).toHaveTextContent(
    "unread row",
  );
});

it("keeps a frozen boundary from trailing a committed own message", async () => {
  const { container } = render(() => (
    <MessageList
      messages={[
        { ...message, delivery: "received" },
        {
          ...message,
          id: 2,
          delivery: "received",
          text: "unread peer",
          received_at_ms: 2,
        },
        {
          ...message,
          id: 3,
          authorship: "own",
          delivery: "confirmed",
          text: "own reply",
          received_at_ms: 3,
        },
      ]}
      readAtMs={1}
    />
  ));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(container.querySelector("[data-new-line]")).toBeNull();
});

it("keeps the unread line in place when the reader leaves the live edge", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const messages = Array.from({ length: 3 }, (_, index) => ({
    ...message,
    id: index + 1,
    text: `message ${index + 1}`,
    received_at_ms: index + 1,
  }));
  const [shown, setShown] = createSignal(messages.slice(0, 1));
  const { container } = render(() => (
    <MessageList messages={shown()} readAtMs={1} />
  ));
  const list = container.querySelector<HTMLOListElement>("[data-message-list]");
  if (list === null) throw new Error("message list is missing");
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 50 },
    scrollHeight: { configurable: true, value: 500 },
  });
  const removedLines: Node[] = [];
  new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.removedNodes)
        if (
          node instanceof HTMLElement &&
          (node.matches("[data-new-line]") ||
            node.querySelector("[data-new-line]") !== null)
        )
          removedLines.push(node);
  }).observe(list, { childList: true, subtree: true });

  fireEvent.wheel(list, { deltaY: -100 });
  list.scrollTop = 0;
  list.dispatchEvent(new Event("scroll"));
  setShown(messages);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(removedLines).toEqual([]);
  const newLine = container.querySelector("[data-new-line]");
  expect(newLine?.closest("li")?.nextElementSibling).toHaveTextContent(
    "message 2",
  );
});

it("does not add New for a message arriving at the focused live edge", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const [messages, setMessages] = createSignal<readonly MessageProjection[]>([
    { ...message, delivery: "received" },
  ]);
  const { container } = render(() => (
    <MessageList messages={messages()} readAtMs={1} />
  ));

  setMessages([
    ...messages(),
    {
      ...message,
      id: 2,
      delivery: "received",
      text: "arriving now",
      received_at_ms: 2,
    },
  ]);
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(container.querySelector("[data-new-line]")).toBeNull();
});

it("restacks measured rows when the New boundary moves past a long row", async () => {
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
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const longText = (label: string) =>
    `${label} ${"the deploy health check failed again ".repeat(12)}`;
  const [readAtMs, setReadAtMs] = createSignal<number | null>(1);
  const { container } = render(() => (
    <MessageList
      bufferId={2}
      messages={[
        message,
        {
          ...message,
          id: 2,
          text: longText("first"),
          received_at_ms: 2,
        },
        {
          ...message,
          id: 3,
          text: longText("second"),
          received_at_ms: 3,
        },
      ]}
      readAtMs={readAtMs()}
    />
  ));
  const flushRowSizes = async () => {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    for (const row of container.querySelectorAll("li[data-index]"))
      for (const observer of observers)
        observer.flushTarget(row, measuredRowHeight(row));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  };
  await flushRowSizes();

  setReadAtMs(2);
  await flushRowSizes();

  const rows = renderedRowGeometry(container);
  expect(rows.map((row) => row.newLine)).toEqual([
    false,
    false,
    false,
    true,
    false,
  ]);
  expect(rows.slice(1).map((row) => row.start)).toEqual(
    rows.slice(0, -1).map((row) => row.start + row.size),
  );
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
  const observers: ControlledIntersectionObserver[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class extends ControlledIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        super(callback);
        observers.push(this);
      }
    },
  );
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
  fireEvent.wheel(list, { deltaY: -100 });
  list.scrollTop = 0;
  list.dispatchEvent(new Event("scroll"));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const observer = observers[0];
  if (observer === undefined) throw new Error("live-edge observer is missing");
  observer.flush(false);

  setMessages([
    ...initial,
    { ...message, id: 51, text: "arrived away", received_at_ms: 51 },
  ]);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(screen.getByRole("button", { name: /1 new message/ })).toBeVisible();
  expect(list.scrollTop).toBe(0);
}, 15_000);

it("reports the live edge from the bottom sentinel", async () => {
  const observers: ControlledIntersectionObserver[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class extends ControlledIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        super(callback);
        observers.push(this);
      }
    },
  );
  const onLiveEdgeChange = vi.fn();
  const { container } = render(() => (
    <MessageList
      messages={[message, { ...message, id: 2 }]}
      onLiveEdgeChange={onLiveEdgeChange}
    />
  ));
  const list = container.querySelector<HTMLOListElement>("[data-message-list]");
  if (list === null) throw new Error("message list is missing");
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 1_300 },
  });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const observer = observers[0];
  if (observer === undefined) throw new Error("live-edge observer is missing");

  fireEvent.wheel(list, { deltaY: -100 });
  list.scrollTop = 0;
  list.dispatchEvent(new Event("scroll"));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  observer.flush(false);
  expect(onLiveEdgeChange).toHaveBeenLastCalledWith(false);

  list.scrollTop = 800;
  list.dispatchEvent(new Event("scroll"));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  observer.flush(true);
  expect(onLiveEdgeChange).toHaveBeenLastCalledWith(true);
});

it("reports the live edge once the virtualizer catches up with the sentinel", async () => {
  const observers: ControlledIntersectionObserver[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class extends ControlledIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        super(callback);
        observers.push(this);
      }
    },
  );
  const onLiveEdgeChange = vi.fn();
  const messages = Array.from({ length: 50 }, (_, index) => ({
    ...message,
    id: index + 1,
    text: `message ${index + 1}`,
    received_at_ms: index + 1,
  }));
  const { container } = render(() => (
    <MessageList messages={messages} onLiveEdgeChange={onLiveEdgeChange} />
  ));
  const list = container.querySelector<HTMLOListElement>("[data-message-list]");
  if (list === null) throw new Error("message list is missing");
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 1_300 },
  });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  onLiveEdgeChange.mockClear();
  fireEvent.wheel(list, { deltaY: -100 });
  list.scrollTop = 0;
  list.dispatchEvent(new Event("scroll"));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const observer = observers[0];
  if (observer === undefined) throw new Error("live-edge observer is missing");
  observer.flush(false);
  observer.flush(true);
  expect(onLiveEdgeChange.mock.calls).toEqual([[false]]);

  list.scrollTop = 800;
  list.dispatchEvent(new Event("scroll"));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  expect(onLiveEdgeChange).toHaveBeenLastCalledWith(true);

  onLiveEdgeChange.mockClear();
  list.scrollTop = 0;
  list.dispatchEvent(new Event("scroll"));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  expect(onLiveEdgeChange).toHaveBeenLastCalledWith(false);
});

it("keeps following through a transient one-row render gap", async () => {
  const observers: ControlledIntersectionObserver[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class extends ControlledIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        super(callback);
        observers.push(this);
      }
    },
  );
  const [messages, setMessages] = createSignal([message]);
  const { container } = render(() => <MessageList messages={messages()} />);
  const list = container.querySelector<HTMLOListElement>("[data-message-list]");
  if (list === null) throw new Error("message list is missing");
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 1_300 },
  });
  const observer = observers[0];
  if (observer === undefined) throw new Error("live-edge observer is missing");
  observer.flush(false);
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
      messages={[
        {
          ...message,
          author: "an-extremely-long-nickname",
        },
        { ...message, id: 2, author: "short" },
      ]}
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

class ControlledIntersectionObserver {
  readonly #callback: IntersectionObserverCallback;
  #target: Element | undefined;

  constructor(callback: IntersectionObserverCallback) {
    this.#callback = callback;
  }

  observe(target: Element): void {
    this.#target = target;
  }

  disconnect(): void {
    this.#target = undefined;
  }

  flush(isIntersecting: boolean): void {
    if (this.#target === undefined) return;
    this.#callback(
      [
        {
          isIntersecting,
          target: this.#target,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
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

function renderedRowGeometry(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLLIElement>("li[data-index]")]
    .map((row) => ({
      index: Number(row.dataset.index),
      newLine: row.querySelector("[data-new-line]") !== null,
      start: translateY(row.style.transform),
      size: measuredRowHeight(row),
    }))
    .sort((left, right) => left.index - right.index);
}

function translateY(transform: string): number {
  const match = /translateY\(([-\d.]+)px\)/.exec(transform);
  return Number(match?.[1] ?? 0);
}
