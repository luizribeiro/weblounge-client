import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type { BufferProjection } from "../../engine/protocol";
import { MobileChatList } from "./MobileChatList";
import type { ChatFilter } from "./mobile-chats";

const base = {
  network_id: 1,
  draft_key: "draft",
  topic: null,
  unread: 0,
  mentions: 0,
  read_through: null,
};
const buffers: BufferProjection[] = [
  { ...base, id: 2, kind: "channel", title: "#garden" },
  { ...base, id: 3, kind: "direct", title: "mel" },
];

it("updates chat filters and search through accessible controls", () => {
  const open = vi.fn();
  const Harness = () => {
    const [filter, setFilter] = createSignal<ChatFilter>("all");
    const [query, setQuery] = createSignal("");
    return (
      <MobileChatList
        networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
        buffers={buffers}
        filter={filter()}
        query={query()}
        scrollTop={0}
        onFilter={setFilter}
        onOpen={open}
        onQuery={setQuery}
        onScroll={() => {}}
      />
    );
  };
  render(Harness);

  fireEvent.click(screen.getByRole("button", { name: "Channels" }));
  expect(screen.getByRole("button", { name: "#garden" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "mel" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  fireEvent.input(screen.getByRole("searchbox", { name: "Search chats" }), {
    target: { value: "mel" },
  });
  fireEvent.click(screen.getByRole("button", { name: "mel" }));
  expect(open).toHaveBeenCalledWith(3);
});

it("omits the preview element at compact mobile density", () => {
  document.documentElement.dataset.mobileDensity = "compact";
  render(() => (
    <MobileChatList
      buffers={[
        {
          ...base,
          id: 3,
          kind: "direct",
          title: "mel",
          last_message: {
            id: 8,
            author: "mel",
            text: "compact preview",
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
          },
        },
      ]}
      filter="all"
      networks={[]}
      onFilter={() => {}}
      onOpen={() => {}}
      onQuery={() => {}}
      onScroll={() => {}}
      query=""
      scrollTop={0}
    />
  ));

  expect(screen.queryByText("mel: compact preview")).not.toBeInTheDocument();
  delete document.documentElement.dataset.mobileDensity;
});
