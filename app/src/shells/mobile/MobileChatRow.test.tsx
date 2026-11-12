import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type {
  BufferProjection,
  MessageProjection,
} from "../../engine/protocol";
import { MessageList } from "../../features/conversation/MessageList";
import { MobileChatRow } from "./MobileChatRow";

const lastMessage: MessageProjection = {
  id: 8,
  author: "mel",
  text: "See you there",
  kind: "text",
  bot: false,
  authorship: "other",
  nick_color_index: 0,
  highlighted: true,
  delivery: "received",
  local_send_id: null,
  server_ids: ["eight"],
  server_time_ms: 1_700_000_000_000,
  received_at_ms: 1_700_000_000_000,
};

function buffer(overrides: Partial<BufferProjection> = {}): BufferProjection {
  return {
    id: 2,
    network_id: 2,
    sync_state: "synced" as const,
    kind: "channel",
    title: "#garden",
    draft_key: "garden",
    topic: null,
    unread: 3,
    mentions: 1,
    last_message: lastMessage,
    preview: "mel: See you there",
    ...overrides,
  };
}

it("renders preview, non-default network, time, and mention badge", () => {
  render(() => (
    <MobileChatRow
      buffer={buffer()}
      networkLabel="Libera"
      onOpen={vi.fn()}
      onPressStart={() => {}}
      previews={true}
    />
  ));

  expect(screen.getByText("Libera")).toBeVisible();
  expect(screen.getByText("mel: See you there")).toBeVisible();
  expect(
    screen.getByLabelText("3 unread, including mentions"),
  ).toHaveTextContent("3");
  expect(document.querySelector("time")).toBeInTheDocument();
});

it("renders cached activity without a live message", () => {
  const activity = lastMessage.server_time_ms ?? lastMessage.received_at_ms;
  const { last_message: _, ...cachedBuffer } = buffer({
    last_activity_ms: activity,
    preview: "mel: See you there",
  });
  render(() => (
    <MobileChatRow buffer={cachedBuffer} onOpen={vi.fn()} previews={true} />
  ));

  expect(document.querySelector("time")).toHaveTextContent(
    new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(activity),
  );
});

it("omits the default network label and shows the unread count", () => {
  render(() => (
    <MobileChatRow
      buffer={buffer({ mentions: 0 })}
      onOpen={vi.fn()}
      onPressStart={() => {}}
      previews={true}
    />
  ));

  expect(screen.queryByText("Libera")).not.toBeInTheDocument();
  expect(screen.getByLabelText("3 unread")).toBeVisible();
  expect(screen.getByLabelText("3 unread")).toHaveTextContent("3");
});

it("sizes avatar text from density and colours direct initials by nick", () => {
  const { container } = render(() => (
    <MobileChatRow
      buffer={buffer({
        kind: "direct",
        title: "mel",
        nick_color_index: 7,
      })}
      onOpen={vi.fn()}
      onPressStart={() => {}}
      previews={true}
    />
  ));

  const avatar = container.querySelector<HTMLElement>(
    "[data-nick-color-index='7']",
  );
  expect(avatar).toHaveTextContent("M");
  expect(avatar).toHaveStyle({ color: "var(--wl-nick-1)" });
});

it("uses the same locale time in chat previews and message rows", () => {
  const { container } = render(() => (
    <>
      <MobileChatRow
        buffer={buffer()}
        onOpen={vi.fn()}
        onPressStart={() => {}}
        previews={true}
      />
      <MessageList messages={[lastMessage]} />
    </>
  ));

  const times = [...container.querySelectorAll("time")].map(
    (time) => time.textContent,
  );
  expect(times).toHaveLength(2);
  expect(times[0]).toBe(times[1]);
});

it("omits the peer name from direct previews and labels own messages", () => {
  const direct = buffer({
    kind: "direct",
    title: "mel",
    preview: "See you there",
  });
  const { unmount } = render(() => (
    <MobileChatRow
      buffer={direct}
      onOpen={vi.fn()}
      onPressStart={() => {}}
      previews={true}
    />
  ));

  expect(screen.getByText("See you there")).toBeVisible();
  expect(screen.queryByText("mel: See you there")).not.toBeInTheDocument();
  unmount();
  render(() => (
    <MobileChatRow
      buffer={{
        ...direct,
        last_message: { ...lastMessage, author: "me", authorship: "own" },
        preview: "You: See you there",
      }}
      onOpen={vi.fn()}
      onPressStart={() => {}}
      previews={true}
    />
  ));
  expect(screen.getByText("You: See you there")).toBeVisible();
});

it("keeps a long message's full text unique to the conversation", () => {
  const text =
    "A deliberately long mobile message wraps beneath itself instead of reserving desktop columns on this narrow screen.";
  const message = { ...lastMessage, text };
  render(() => (
    <>
      <MobileChatRow
        buffer={buffer({
          kind: "direct",
          title: "mel",
          last_message: message,
          preview: `${[...text].slice(0, 80).join("")}…`,
        })}
        onOpen={vi.fn()}
        onPressStart={() => {}}
        previews={true}
      />
      <MessageList messages={[message]} />
    </>
  ));

  expect(screen.getAllByText(text, { exact: true })).toHaveLength(1);
  expect(
    screen.getByText(/A deliberately long mobile message.*…/u),
  ).toBeVisible();
});

it("reveals row actions and runs Mark as read", () => {
  const markRead = vi.fn();
  const Harness = () => {
    const [revealed, setRevealed] = createSignal(false);
    return (
      <MobileChatRow
        buffer={buffer()}
        onMarkRead={markRead}
        onOpen={vi.fn()}
        onReset={() => setRevealed(false)}
        onReveal={() => setRevealed(true)}
        previews={true}
        revealed={revealed()}
      />
    );
  };
  const { container } = render(Harness);
  const wrapper = mobileRowWrapper(container);

  fireEvent.pointerDown(wrapper, pointer(300, 100, 0));
  fireEvent.pointerMove(wrapper, pointer(230, 101, 100));
  fireEvent.pointerUp(wrapper, pointer(230, 101, 150));

  expect(wrapper).toHaveAttribute("data-swipe-state", "revealed");
  fireEvent.click(screen.getByRole("button", { name: "Read" }));
  expect(markRead).toHaveBeenCalledOnce();
  expect(wrapper).toHaveAttribute("data-swipe-state", "closed");
});

it("full-swipes a direct conversation into the existing close callback", () => {
  const close = vi.fn();
  const { container } = render(() => (
    <MobileChatRow
      buffer={buffer({ kind: "direct", title: "mel" })}
      onOpen={vi.fn()}
      onRequestClose={close}
      previews={true}
    />
  ));
  const wrapper = mobileRowWrapper(container);

  fireEvent.pointerDown(wrapper, pointer(390, 100, 0));
  fireEvent.pointerMove(wrapper, pointer(130, 100, 100));
  fireEvent.pointerUp(wrapper, pointer(130, 100, 150));

  expect(close).toHaveBeenCalledOnce();
});

function mobileRowWrapper(container: HTMLElement): HTMLDivElement {
  const wrapper = container.querySelector<HTMLDivElement>(
    "[data-mobile-row-wrapper]",
  );
  if (wrapper === null) throw new Error("mobile row wrapper missing");
  vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue({
    bottom: 164,
    height: 64,
    left: 0,
    right: 400,
    top: 100,
    width: 400,
    x: 0,
    y: 100,
    toJSON: () => ({}),
  });
  return wrapper;
}

function pointer(clientX: number, clientY: number, timeStamp: number) {
  return {
    button: 0,
    clientX,
    clientY,
    isPrimary: true,
    pointerId: 1,
    timeStamp,
  };
}
