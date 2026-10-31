import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
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
        restoreScroll={() => 0}
        restoreVersion={() => 0}
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
  const direct = screen.getByRole("button", { name: "mel" });
  const list = direct.parentElement;
  if (!(list instanceof HTMLElement)) throw new Error("chat list missing");
  list.scrollTop = 37;
  fireEvent.wheel(list);
  fireEvent.scroll(list);
  list.scrollTop = 0;
  fireEvent.scroll(list);
  fireEvent(list, new Event("scrollend"));
  fireEvent.click(direct);
  expect(open).toHaveBeenCalledWith(3, 37);
});

it("keeps row elements when buffer projections are replaced", () => {
  const [current, setCurrent] =
    createSignal<readonly BufferProjection[]>(buffers);
  render(() => (
    <MobileChatList
      buffers={current()}
      filter="all"
      networks={[]}
      onFilter={() => {}}
      onOpen={() => {}}
      onQuery={() => {}}
      onScroll={() => {}}
      query=""
      restoreScroll={() => 0}
      restoreVersion={() => 0}
    />
  ));
  const original = screen.getByRole("button", { name: "#garden" });

  setCurrent(
    buffers.map((buffer) =>
      buffer.id === 2 ? { ...buffer, unread: 1 } : buffer,
    ),
  );

  expect(screen.getByRole("button", { name: "#garden" })).toBe(original);
  expect(screen.getByLabelText("1 unread")).toBeVisible();
});

it("restores the retained chat list after returning from a conversation", async () => {
  const [restoreScroll, setRestoreScroll] = createSignal(0);
  const [restoreVersion, setRestoreVersion] = createSignal(0);
  render(() => (
    <MobileChatList
      buffers={buffers}
      filter="all"
      networks={[]}
      onFilter={() => {}}
      onOpen={() => {}}
      onQuery={() => {}}
      onScroll={() => {}}
      query=""
      restoreScroll={restoreScroll}
      restoreVersion={restoreVersion}
    />
  ));
  const direct = screen.getByRole("button", { name: "mel" });
  const list = direct.parentElement;
  if (!(list instanceof HTMLElement)) throw new Error("chat list missing");
  list.scrollTop = 0;

  setRestoreScroll(57);
  setRestoreVersion(1);

  await waitFor(() => expect(list.scrollTop).toBe(57));
});

it("does not overwrite a user scroll with a pending restore frame", () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const requestFrame = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      const frame = nextFrame;
      nextFrame += 1;
      frames.set(frame, callback);
      return frame;
    });
  const cancelFrame = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((frame) => {
      frames.delete(frame);
    });
  const onScroll = vi.fn();
  render(() => (
    <MobileChatList
      buffers={buffers}
      filter="all"
      networks={[]}
      onFilter={() => {}}
      onOpen={() => {}}
      onQuery={() => {}}
      onScroll={onScroll}
      query=""
      restoreScroll={() => 57}
      restoreVersion={() => 0}
    />
  ));
  const list = screen.getByRole("button", { name: "mel" }).parentElement;
  if (!(list instanceof HTMLElement)) throw new Error("chat list missing");

  fireEvent.wheel(list);
  list.scrollTop = 23;
  fireEvent.scroll(list);
  for (const callback of frames.values()) callback(0);

  expect(list.scrollTop).toBe(23);
  expect(onScroll).toHaveBeenCalledWith(23);
  expect(cancelFrame).toHaveBeenCalled();
  requestFrame.mockRestore();
  cancelFrame.mockRestore();
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
            highlighted: false,
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
      restoreScroll={() => 0}
      restoreVersion={() => 0}
    />
  ));

  expect(screen.queryByText("mel: compact preview")).not.toBeInTheDocument();
  delete document.documentElement.dataset.mobileDensity;
});
