import { render, screen } from "@solidjs/testing-library";
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
  mode_symbol: null,
  authorship: "other",
  nick_color_index: 0,
  mentioned: true,
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
    kind: "channel",
    title: "#garden",
    draft_key: "garden",
    topic: null,
    unread: 3,
    mentions: 1,
    read_through: null,
    last_message: lastMessage,
    ...overrides,
  };
}

it("renders preview, non-default network, time, and mention badge", () => {
  render(() => (
    <MobileChatRow
      buffer={buffer()}
      networkLabel="Libera"
      onOpen={vi.fn()}
      previews={true}
    />
  ));

  expect(screen.getByText("Libera")).toBeVisible();
  expect(screen.getByText("mel: See you there")).toBeVisible();
  expect(screen.getByLabelText("1 mentions")).toBeVisible();
  expect(document.querySelector("time")).toBeInTheDocument();
});

it("omits the default network label and uses the unread badge", () => {
  render(() => (
    <MobileChatRow
      buffer={buffer({ mentions: 0 })}
      onOpen={vi.fn()}
      previews={true}
    />
  ));

  expect(screen.queryByText("Libera")).not.toBeInTheDocument();
  expect(screen.getByLabelText("3 unread")).toBeVisible();
});

it("uses the same locale time in chat previews and message rows", () => {
  const { container } = render(() => (
    <>
      <MobileChatRow buffer={buffer()} onOpen={vi.fn()} previews={true} />
      <MessageList messages={[lastMessage]} />
    </>
  ));

  const times = [...container.querySelectorAll("time")].map(
    (time) => time.textContent,
  );
  expect(times).toHaveLength(2);
  expect(times[0]).toBe(times[1]);
});
