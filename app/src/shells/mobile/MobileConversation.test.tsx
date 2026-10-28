import { render, screen } from "@solidjs/testing-library";
import { onMount } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  BufferProjection,
  MessageProjection,
} from "../../engine/protocol";
import { MobileConversation } from "./MobileConversation";

vi.mock("../../features/composer/Composer", () => ({
  Composer: () => <div data-composer="true" />,
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
  kind: "direct",
  title: "mel",
  draft_key: "mel",
  topic: null,
  unread: 1,
  mentions: 0,
  read_through: 7,
};

const message: MessageProjection = {
  id: 8,
  author: "mel",
  text: "hello",
  kind: "text",
  bot: false,
  mode_symbol: null,
  authorship: "other",
  nick_color_index: 0,
  mentioned: false,
  delivery: "received",
  local_send_id: null,
  server_ids: ["eight"],
  server_time_ms: 8,
  received_at_ms: 8,
};

let focused = true;
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
});

afterEach(() => {
  focused = true;
  visibility = "visible";
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

it("waits for both visibility and window focus before starting the dwell", () => {
  visibility = "hidden";
  focused = false;
  const markRead = vi.fn();
  renderConversation(markRead);

  vi.advanceTimersByTime(1_000);
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(1_000);
  expect(markRead).not.toHaveBeenCalled();

  focused = true;
  window.dispatchEvent(new Event("focus"));
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
