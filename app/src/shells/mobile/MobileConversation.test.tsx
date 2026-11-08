import { render, screen } from "@solidjs/testing-library";
import { createSignal, onMount } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  BufferProjection,
  MessageProjection,
} from "../../engine/protocol";
import { MobileConversation } from "./MobileConversation";

vi.mock("../../features/composer/Composer", () => ({
  Composer: (props: { readonly disabled?: boolean }) => (
    <div data-composer="true" data-disabled={props.disabled} />
  ),
}));

vi.mock("../../features/conversation/MessageList", () => ({
  MessageList: (props: {
    readonly onLiveEdgeChange?: (atLiveEdge: boolean) => void;
  }) => {
    onMount(() => props.onLiveEdgeChange?.(true));
    return <div data-message-list="true" />;
  },
}));

const buffer: BufferProjection = {
  id: 2,
  network_id: 1,
  sync_state: "synced" as const,
  kind: "direct",
  title: "mel",
  draft_key: "mel",
  topic: null,
  unread: 1,
  mentions: 0,
};

const message: MessageProjection = {
  id: 8,
  author: "mel",
  text: "hello",
  kind: "text",
  bot: false,
  authorship: "other",
  nick_color_index: 0,
  highlighted: false,
  delivery: "received",
  local_send_id: null,
  server_ids: ["eight"],
  server_time_ms: 8,
  received_at_ms: 8,
};

let focused = true;
let hidden = false;
const standaloneDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "standalone",
);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
});

afterEach(() => {
  focused = true;
  hidden = false;
  if (standaloneDescriptor === undefined)
    Reflect.deleteProperty(navigator, "standalone");
  else Object.defineProperty(navigator, "standalone", standaloneDescriptor);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("marks the latest committed message read after a 500ms live-edge dwell", () => {
  const markRead = vi.fn();
  renderConversation(markRead);

  vi.advanceTimersByTime(499);
  expect(markRead).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(markRead).toHaveBeenCalledOnce();
  expect(markRead).toHaveBeenCalledWith(2, 8);
});

it("keeps the dwell across equal buffer and message replacements", () => {
  const [snapshot, setSnapshot] = createSignal({
    buffer,
    messages: [message] as readonly MessageProjection[],
  });
  const markRead = vi.fn();
  render(() => (
    <MobileConversation
      buffer={snapshot().buffer}
      memberships={[]}
      messages={snapshot().messages}
      onBack={() => {}}
      onLoadHistory={() => {}}
      onMarkRead={markRead}
      onOpenMembers={() => {}}
      onRequestCompletion={() => {}}
      onSend={async () => true}
    />
  ));

  vi.advanceTimersByTime(300);
  setSnapshot((current) => ({
    buffer: { ...current.buffer },
    messages: current.messages.map((item) => ({ ...item })),
  }));
  vi.advanceTimersByTime(200);

  expect(markRead).toHaveBeenCalledOnce();
  expect(markRead).toHaveBeenCalledWith(2, 8);
});

it("cancels the dwell when the conversation becomes inactive", () => {
  const [visible, setVisible] = createSignal(true);
  const [snapshot, setSnapshot] = createSignal({
    buffer,
    messages: [message] as readonly MessageProjection[],
  });
  const markRead = vi.fn();
  render(() => (
    <MobileConversation
      buffer={snapshot().buffer}
      memberships={[]}
      messages={snapshot().messages}
      onBack={() => {}}
      onLoadHistory={() => {}}
      onMarkRead={markRead}
      onOpenMembers={() => {}}
      onRequestCompletion={() => {}}
      onSend={async () => true}
      visible={visible()}
    />
  ));

  vi.advanceTimersByTime(500);
  expect(markRead).toHaveBeenCalledOnce();
  setVisible(false);
  setSnapshot({
    buffer: { ...buffer, unread: 2 },
    messages: [message, { ...message, id: 9 }],
  });
  vi.advanceTimersByTime(500);
  expect(markRead).toHaveBeenCalledOnce();
  setVisible(true);
  vi.advanceTimersByTime(500);
  expect(markRead).toHaveBeenLastCalledWith(2, 9);
  expect(markRead).toHaveBeenCalledTimes(2);
});

it("waits for both visibility and window focus before starting the dwell", () => {
  hidden = true;
  focused = false;
  const markRead = vi.fn();
  renderConversation(markRead);

  vi.advanceTimersByTime(1_000);
  hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(1_000);
  expect(markRead).not.toHaveBeenCalled();

  focused = true;
  window.dispatchEvent(new Event("focus"));
  vi.advanceTimersByTime(500);
  expect(markRead).toHaveBeenCalledWith(2, 8);
});

it("treats a visible iOS standalone conversation as foreground", () => {
  focused = false;
  Object.defineProperty(navigator, "standalone", {
    configurable: true,
    value: true,
  });
  const markRead = vi.fn();
  renderConversation(markRead);

  vi.advanceTimersByTime(500);

  expect(markRead).toHaveBeenCalledWith(2, 8);
});

it("shows the members action only for channels", () => {
  const result = render(() =>
    conversation({ ...buffer, kind: "channel", title: "#room" }, () => {}),
  );
  expect(screen.getByRole("button", { name: "Show members" })).toBeVisible();
  result.unmount();
  render(() => conversation({ ...buffer, kind: "direct" }, () => {}));
  expect(screen.queryByRole("button", { name: "Show members" })).toBeNull();
});

it("keeps a kicked channel readable and disables its composer", () => {
  render(() =>
    conversation(
      {
        ...buffer,
        kind: "channel",
        channel_status: "kicked",
        title: "#room",
      },
      () => {},
    ),
  );

  expect(screen.getByRole("status")).toHaveTextContent(
    "You were kicked from #room. Rejoin to send messages.",
  );
  expect(document.querySelector("[data-composer]")).toHaveAttribute(
    "data-disabled",
    "true",
  );
  expect(document.querySelector("[data-message-list]")).not.toBeNull();
});

it("resolves a cached direct through normal history", () => {
  const loadHistory = vi.fn();
  render(() => (
    <MobileConversation
      buffer={{ ...buffer, unread: 2, mentions: 2 }}
      memberships={[]}
      messages={[]}
      onBack={() => {}}
      onLoadHistory={loadHistory}
      onMarkRead={() => {}}
      onOpenMembers={() => {}}
      onRequestCompletion={() => {}}
      onSend={async () => true}
    />
  ));

  expect(loadHistory).toHaveBeenCalledWith(2, "latest");
  expect(document.querySelector("[data-message-list]")).not.toBeNull();
});

it("resolves a cached channel through normal history", () => {
  const loadHistory = vi.fn();
  render(() => (
    <MobileConversation
      buffer={{
        ...buffer,
        kind: "channel",
        title: "#room",
      }}
      memberships={[]}
      messages={[]}
      onBack={() => {}}
      onLoadHistory={loadHistory}
      onMarkRead={() => {}}
      onOpenMembers={() => {}}
      onRequestCompletion={() => {}}
      onSend={async () => true}
    />
  ));

  expect(loadHistory).toHaveBeenCalledWith(2, "latest");
});

it("shows an identity mismatch, blocks sending, and routes both decisions", () => {
  const trust = vi.fn();
  const defer = vi.fn();
  render(() => (
    <MobileConversation
      buffer={{ ...buffer, direct_identity: "different_account" }}
      memberships={[]}
      messages={[message]}
      onBack={() => {}}
      onDeferDirectIdentity={defer}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onOpenMembers={() => {}}
      onRequestCompletion={() => {}}
      onSend={async () => true}
      onTrustDirectIdentity={trust}
    />
  ));

  expect(screen.getByRole("alert")).toHaveTextContent(
    "This isn't the same mel — different account",
  );
  expect(document.querySelector("[data-composer]")).toHaveAttribute(
    "data-disabled",
    "true",
  );
  screen.getByRole("button", { name: "Trust new identity" }).click();
  screen.getByRole("button", { name: "Not now" }).click();
  expect(trust).toHaveBeenCalledWith(2);
  expect(defer).toHaveBeenCalledWith(2);
});

function renderConversation(
  onMarkRead: (bufferId: number, through: number) => void,
) {
  return render(() => conversation(buffer, onMarkRead));
}

function conversation(
  currentBuffer: BufferProjection,
  onMarkRead: (bufferId: number, through: number) => void,
) {
  return (
    <MobileConversation
      buffer={currentBuffer}
      memberships={[]}
      messages={[message]}
      onBack={() => {}}
      onLoadHistory={() => {}}
      onMarkRead={onMarkRead}
      onOpenMembers={() => {}}
      onRequestCompletion={() => {}}
      onSend={async () => true}
    />
  );
}
