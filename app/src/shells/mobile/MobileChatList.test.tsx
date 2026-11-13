import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type { BufferProjection } from "../../engine/protocol";
import { MobileChatList } from "./MobileChatList";
import type { ChatFilter } from "./mobile-chats";

const base = {
  network_id: 1,
  sync_state: "synced" as const,
  draft_key: "draft",
  topic: null,
  unread: 0,
  mentions: 0,
};
const buffers: BufferProjection[] = [
  { ...base, id: 2, kind: "channel", title: "#garden" },
  { ...base, id: 3, kind: "direct", title: "mel" },
];

it("places the notification prompt above the mobile chat list", () => {
  const turnOn = vi.fn();
  const dismiss = vi.fn();
  render(() => (
    <MobileChatList
      buffers={buffers}
      filter="all"
      networks={[]}
      notificationPromptVisible
      onDismissNotificationPrompt={dismiss}
      onFilter={() => {}}
      onOpen={() => {}}
      onQuery={() => {}}
      onScroll={() => {}}
      onTurnOnNotifications={turnOn}
      query=""
      restoreScroll={() => 0}
      restoreVersion={() => 0}
    />
  ));

  const prompt = screen.getByRole("region", { name: "Notifications" });
  const chats = screen.getByRole("region", { name: "Chats" });
  expect(chats.contains(prompt)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss notification prompt" }),
  );
  expect(turnOn).toHaveBeenCalledOnce();
  expect(dismiss).toHaveBeenCalledOnce();
});

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
  const list = direct.closest("[data-mobile-chat-list]");
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

it("uses only the logo for connection progress and one strip for failures", () => {
  const retry = vi.fn();
  const { container, unmount } = render(() => (
    <MobileChatList
      buffers={buffers}
      filter="all"
      networks={[
        { id: 1, label: "Local", nickname: "me", state: "connecting" },
      ]}
      onFilter={() => {}}
      onOpen={() => {}}
      onQuery={() => {}}
      onRetryNetwork={retry}
      onScroll={() => {}}
      query=""
      restoreScroll={() => 0}
      restoreVersion={() => 0}
    />
  ));

  expect(container.querySelector("[data-connection-progress]")).not.toBeNull();
  expect(screen.queryByText(/connecting|offline|reconnecting/iu)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  unmount();

  render(() => (
    <MobileChatList
      buffers={buffers}
      filter="all"
      networks={[
        {
          id: 1,
          label: "Local",
          nickname: "me",
          state: {
            failed: {
              reason: "transport",
              message_key: "engine.connection_failed",
            },
          },
        },
      ]}
      onFilter={() => {}}
      onOpen={() => {}}
      onQuery={() => {}}
      onRetryNetwork={retry}
      onScroll={() => {}}
      query=""
      restoreScroll={() => 0}
      restoreVersion={() => 0}
    />
  ));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledWith(1);
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

  expect(screen.getByRole("button", { name: "#garden, 1 unread" })).toBe(
    original,
  );
  expect(screen.getByLabelText("1 unread")).toBeVisible();
});

it("keeps recent mixed order and rendered times across projection updates", () => {
  const times = [1_700_000_200_000, 1_700_000_300_000] as const;
  const cached: BufferProjection[] = [
    {
      ...base,
      id: 3,
      kind: "channel",
      title: "#garden",
      preview: "#garden: middle",
      last_activity_ms: times[0],
    },
    {
      ...base,
      id: 4,
      kind: "direct",
      title: "carol",
      preview: "newest",
      last_activity_ms: times[1],
    },
  ];
  const live: BufferProjection[] = cached.map((buffer, index) => {
    const activity = buffer.last_activity_ms ?? 0;
    return {
      ...buffer,
      last_message: {
        id: index + 1,
        author: buffer.title,
        text: index === 0 ? "middle" : "newest",
        kind: "text",
        bot: false,
        mode_symbol: null,
        authorship: "other",
        nick_color_index: 0,
        highlighted: false,
        delivery: "received",
        local_send_id: null,
        server_ids: [`message-${index}`],
        server_time_ms: activity,
        received_at_ms: activity,
      },
    };
  });
  const [current, setCurrent] =
    createSignal<readonly BufferProjection[]>(cached);
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
  const visibleRows = () =>
    [...document.querySelectorAll<HTMLElement>("[data-buffer-id]")].map(
      (row) => ({ title: row.ariaLabel, text: row.textContent }),
    );
  const cachedRows = visibleRows();

  setCurrent(live);

  expect(visibleRows()).toEqual(cachedRows);
  expect(visibleRows().map((row) => row.title)).toEqual(["carol", "#garden"]);
});

it("defers activity reordering while a row is pressed", () => {
  const [current, setCurrent] = createSignal<readonly BufferProjection[]>([
    { ...base, id: 2, kind: "channel", title: "#garden", last_activity_ms: 1 },
    { ...base, id: 3, kind: "direct", title: "mel", last_activity_ms: 2 },
  ]);
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
  const visibleTitles = () =>
    [...document.querySelectorAll<HTMLElement>("[data-buffer-id]")].map(
      (row) => row.ariaLabel,
    );

  fireEvent.pointerDown(screen.getByRole("button", { name: "mel" }), {
    isPrimary: true,
  });
  setCurrent([
    { ...base, id: 2, kind: "channel", title: "#garden", last_activity_ms: 3 },
    { ...base, id: 3, kind: "direct", title: "mel", last_activity_ms: 2 },
  ]);
  expect(visibleTitles()).toEqual(["mel", "#garden"]);

  fireEvent.pointerUp(window, { isPrimary: true });
  expect(visibleTitles()).toEqual(["#garden", "mel"]);
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
  const list = direct.closest("[data-mobile-chat-list]");
  if (!(list instanceof HTMLElement)) throw new Error("chat list missing");
  list.scrollTop = 0;

  await waitFor(() =>
    expect(list).not.toHaveAttribute("data-restoring-scroll"),
  );
  setRestoreScroll(57);
  setRestoreVersion(1);

  expect(list).toHaveAttribute("data-restoring-scroll", "true");
  await waitFor(() => expect(list.scrollTop).toBe(57));
  await waitFor(() =>
    expect(list).not.toHaveAttribute("data-restoring-scroll"),
  );
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
  const list = screen
    .getByRole("button", { name: "mel" })
    .closest("[data-mobile-chat-list]");
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
