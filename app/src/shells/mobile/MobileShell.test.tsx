import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { BufferProjection } from "../../engine/protocol";
import type { MemberWindow } from "../../features/members/MemberPanel";
import { installPlatformEnvironment } from "../../platform/environment";
import { MobileShell } from "./MobileShell";

const buffer: BufferProjection = {
  id: 2,
  network_id: 1,
  sync_state: "synced" as const,
  kind: "direct",
  title: "mel",
  draft_key: "mel",
  topic: null,
  unread: 0,
  mentions: 0,
};

afterEach(() => window.history.replaceState({}, "", "/"));

it("clips the shell instead of letting focus reveal scroll it", () => {
  const css = readFileSync("src/shells/mobile/MobileShell.module.css", "utf8");
  expect(css).toMatch(/\.shell \{[^}]*overflow: clip;/u);
});

it("starts a root route on the chats list", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false }) as MediaQueryList),
  );
  render(() => (
    <MobileShell
      buffers={[buffer]}
      composerNotice={undefined}
      completion={undefined}
      initialBufferId={2}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSelectBuffer={() => {}}
      onSend={async () => true}
    />
  ));

  expect(screen.getByRole("region", { name: "Chats" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "mel" })).toBeNull();
});

it("opens a deep link above the chats list", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false }) as MediaQueryList),
  );
  history.replaceState(null, "", "/Local/mel");
  render(() => (
    <MobileShell
      buffers={[buffer]}
      composerNotice={undefined}
      completion={undefined}
      initialBufferId={2}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSelectBuffer={() => {}}
      onSend={async () => true}
    />
  ));

  expect(screen.getByRole("heading", { name: "mel" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Back to chats" }));
  window.dispatchEvent(new PopStateEvent("popstate"));
  expect(screen.getByRole("region", { name: "Chats" })).toBeVisible();
});

it("projects the active buffer's typers into a deep-linked chat", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false }) as MediaQueryList),
  );
  history.replaceState(null, "", "/Local/mel");
  render(() => (
    <MobileShell
      buffers={[buffer]}
      composerNotice={undefined}
      completion={undefined}
      initialBufferId={buffer.id}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSelectBuffer={() => {}}
      onSend={async () => true}
      typers={
        new Map([
          [buffer.id, [{ nick: "ana", nick_color_index: 3, paused: false }]],
        ])
      }
    />
  ));

  expect(document.querySelector("[data-typing-indicator]")).toHaveTextContent(
    "ana is typing…",
  );
});

it("returns to chats and drops the route when the active buffer is removed", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false }) as MediaQueryList),
  );
  history.replaceState(null, "", "/Local/mel");
  const [buffers, setBuffers] = createSignal<readonly BufferProjection[]>([
    buffer,
  ]);
  const [bufferRemoval, setBufferRemoval] = createSignal<{
    readonly bufferId: number;
    readonly previousBufferId: number | undefined;
  }>();
  render(() => (
    <MobileShell
      bufferRemoval={bufferRemoval()}
      buffers={buffers()}
      composerNotice={undefined}
      completion={undefined}
      initialBufferId={buffer.id}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSelectBuffer={() => {}}
      onSend={async () => true}
    />
  ));

  setBufferRemoval({ bufferId: buffer.id, previousBufferId: undefined });
  setBuffers([]);

  expect(screen.getByRole("region", { name: "Chats" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "mel" })).toBeNull();
  expect(window.location.pathname).toBe("/");
});

it("opens a deep link when its buffer resolves after mount", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false }) as MediaQueryList),
  );
  history.replaceState(null, "", "/Local/mel");
  const [initialBufferId, setInitialBufferId] = createSignal<number>();
  render(() => (
    <MobileShell
      buffers={[buffer]}
      composerNotice={undefined}
      completion={undefined}
      initialBufferId={initialBufferId()}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSelectBuffer={() => {}}
      onSend={async () => true}
    />
  ));

  expect(screen.getByRole("region", { name: "Chats" })).toBeVisible();
  setInitialBufferId(2);
  expect(screen.getByRole("heading", { name: "mel" })).toBeVisible();
});

it("exposes only the active chat during a chat-to-chat transition", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false }) as MediaQueryList),
  );
  history.replaceState(null, "", "/Local/mel");
  const nextBuffer = { ...buffer, id: 3, title: "pat", draft_key: "pat" };
  const [focusRequest, setFocusRequest] = createSignal<{
    readonly bufferId: number;
  }>();
  render(() => (
    <MobileShell
      buffers={[buffer, nextBuffer]}
      composerNotice={undefined}
      completion={undefined}
      focusRequest={focusRequest()}
      initialBufferId={buffer.id}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSelectBuffer={() => {}}
      onSend={async () => true}
    />
  ));
  await settledMotion();

  setFocusRequest({ bufferId: nextBuffer.id });

  const outgoing = document
    .querySelector(`[data-mobile-chat="${buffer.id}"]`)
    ?.closest("[aria-hidden]");
  expect(outgoing).toHaveAttribute("aria-hidden", "true");
  expect((outgoing as HTMLElement).inert).toBe(true);
  expect(outgoing).not.toHaveAttribute("data-retained");
  expect(screen.getAllByRole("button", { name: "Back to chats" })).toHaveLength(
    1,
  );
  expect(screen.getByRole("heading", { name: "pat" })).toBeVisible();
});

it("keeps the chat list mounted without reloading history", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true }) as MediaQueryList),
  );
  const loadHistory = vi.fn();
  render(() => (
    <MobileShell
      buffers={[buffer]}
      composerNotice={undefined}
      completion={undefined}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={loadHistory}
      onMarkRead={vi.fn()}
      onRequestCompletion={vi.fn()}
      onSelectBuffer={vi.fn()}
      onSend={async () => true}
    />
  ));

  const chatRow = screen.getByRole("button", { name: "mel" });
  fireEvent.click(chatRow);
  expect(screen.getByRole("heading", { name: "mel" })).toBeVisible();
  await settledMotion();
  expect(chatRow).toBeInTheDocument();
  expect(chatRow.closest("[data-retained]")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  expect(loadHistory).toHaveBeenCalledTimes(1);
  const shell = document.querySelector<HTMLElement>("[data-mobile-shell]");
  if (shell === null) throw new Error("mobile shell is missing");
  expect(
    fireEvent.pointerDown(shell, {
      clientX: 5,
      isPrimary: true,
      pointerId: 7,
    }),
  ).toBe(true);
  fireEvent.pointerMove(shell, { clientX: 10, pointerId: 7 });
  fireEvent.pointerCancel(shell, { clientX: 10, pointerId: 7 });
  await settledMotion();
  expect(screen.getByRole("heading", { name: "mel" })).toBeVisible();
  window.dispatchEvent(new PopStateEvent("popstate"));
  await settledMotion();
  expect(screen.getByRole("region", { name: "Chats" })).toBeVisible();
  expect(screen.getByRole("button", { name: "mel" })).toBe(chatRow);
  expect(loadHistory).toHaveBeenCalledTimes(1);
  expect(document.querySelectorAll("[data-mobile-chat]")).toHaveLength(0);
  fireEvent.click(chatRow);
  await settledMotion();
  expect(screen.getByRole("heading", { name: "mel" })).toBeVisible();
  expect(loadHistory).toHaveBeenCalledTimes(1);
});

it("commits a browser drawer close immediately under reduced motion", () => {
  history.replaceState(null, "", "/Local/room");
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof matchMedia,
  );
  installPlatformEnvironment(document.body, window);
  const channel = {
    ...buffer,
    id: 3,
    kind: "channel" as const,
    title: "#room",
  };
  const requestMembers = vi.fn();
  render(() => (
    <MobileShell
      buffers={[channel]}
      composerNotice={undefined}
      completion={undefined}
      initialBufferId={3}
      memberships={new Map()}
      memberViewScope="test-port"
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onRequestMembers={requestMembers}
      onSelectBuffer={() => {}}
      onSend={async () => true}
    />
  ));

  expect(requestMembers).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Show members" }));
  expect(screen.getByRole("dialog", { name: "Members" })).toBeVisible();
  expect(requestMembers).toHaveBeenCalledWith(
    "test-port:mobile:drawer",
    3,
    0,
    "",
  );
  history.replaceState({ webloungeMobileChat: true }, "", "/Local/room");
  window.dispatchEvent(new PopStateEvent("popstate"));
  expect(screen.queryByRole("dialog", { name: "Members" })).toBeNull();
  expect(screen.getByRole("heading", { name: "#room" })).toBeVisible();
  window.dispatchEvent(new PopStateEvent("popstate"));
  expect(screen.getByRole("region", { name: "Chats" })).toBeVisible();
});

it("requests the active channel instead of reusing another channel's window", async () => {
  history.replaceState(null, "", "/Local/two");
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof matchMedia,
  );
  installPlatformEnvironment(document.body, window);
  const first = {
    ...buffer,
    id: 3,
    kind: "channel" as const,
    title: "#one",
  };
  const second = { ...first, id: 4, title: "#two" };
  const staleWindow: MemberWindow = {
    type: "members_changed",
    buffer_id: first.id,
    view_id: "test-port:mobile:drawer",
    version: 1,
    window_size: 256,
    offset: 0,
    total: 0,
    counts: [0, 0, 0, 0, 0],
    members: [],
  };
  const requestMembers = vi.fn();
  render(() => (
    <MobileShell
      buffers={[first, second]}
      composerNotice={undefined}
      completion={undefined}
      initialBufferId={second.id}
      memberships={new Map()}
      memberViewScope="test-port"
      memberWindows={new Map([[staleWindow.view_id, staleWindow]])}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onRequestMembers={requestMembers}
      onSelectBuffer={() => {}}
      onSend={async () => true}
    />
  ));

  fireEvent.click(screen.getByRole("button", { name: "Show members" }));
  await waitFor(() =>
    expect(requestMembers).toHaveBeenCalledWith(
      "test-port:mobile:drawer",
      second.id,
      0,
      "",
    ),
  );
});

it("clears an in-flight swipe when browser history or visibility wins", async () => {
  history.replaceState(null, "", "/Local/mel");
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false }) as MediaQueryList),
  );
  render(() => (
    <MobileShell
      buffers={[buffer]}
      composerNotice={undefined}
      completion={undefined}
      initialBufferId={2}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSelectBuffer={() => {}}
      onSend={async () => true}
    />
  ));
  const shell = document.querySelector<HTMLElement>("[data-mobile-shell]");
  if (shell === null) throw new Error("mobile shell is missing");

  fireEvent.pointerDown(shell, { clientX: 5, isPrimary: true, pointerId: 7 });
  fireEvent.pointerMove(shell, { clientX: 20, pointerId: 7 });
  fireEvent.pointerMove(shell, { clientX: 100, pointerId: 7 });
  expect(document.querySelector('[data-motion="dragging"]')).not.toBeNull();
  window.dispatchEvent(new PopStateEvent("popstate"));
  fireEvent.pointerUp(shell, { clientX: 100, pointerId: 7 });
  expect(document.querySelector("[data-motion]")).toBeNull();
  expect(screen.getByRole("region", { name: "Chats" })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "mel" }));
  await settledMotion();
  fireEvent.pointerDown(shell, { clientX: 5, isPrimary: true, pointerId: 8 });
  fireEvent.pointerMove(shell, { clientX: 20, pointerId: 8 });
  fireEvent.pointerMove(shell, { clientX: 100, pointerId: 8 });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(document.querySelector("[data-motion]")).toBeNull();
  expect(screen.getByRole("heading", { name: "mel" })).toBeVisible();
});

it("continues a completed swipe closed before unmounting the chat", async () => {
  history.replaceState(null, "", "/Local/mel");
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false }) as MediaQueryList),
  );
  render(() => (
    <MobileShell
      buffers={[buffer]}
      composerNotice={undefined}
      completion={undefined}
      initialBufferId={2}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSelectBuffer={() => {}}
      onSend={async () => true}
    />
  ));
  const shell = document.querySelector<HTMLElement>("[data-mobile-shell]");
  if (shell === null) throw new Error("mobile shell is missing");
  vi.spyOn(shell, "getBoundingClientRect").mockReturnValue({
    width: 1_000,
  } as DOMRect);

  fireEvent.pointerDown(shell, { clientX: 5, isPrimary: true, pointerId: 9 });
  fireEvent.pointerMove(shell, { clientX: 20, pointerId: 9 });
  fireEvent.pointerMove(shell, { clientX: 600, pointerId: 9 });
  fireEvent.pointerUp(shell, { clientX: 600, pointerId: 9 });
  const completing = document.querySelector<HTMLElement>(
    '[data-motion="completing"]',
  );
  expect(completing?.style.getPropertyValue("--wl-push-offset")).toBe("1");
  expect(
    Number(completing?.style.getPropertyValue("--wl-push-settle-scale")),
  ).toBeGreaterThan(0);

  await settledMotion();
  expect(screen.getByRole("region", { name: "Chats" })).toBeVisible();
  expect(document.querySelector("[data-mobile-chat]")).toBeNull();
});

it("pops a completed swipe through history exactly once", async () => {
  history.replaceState({ webloungeMobileChat: true }, "", "/Local/mel");
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false }) as MediaQueryList),
  );
  const back = vi.spyOn(history, "back").mockImplementation(() => {});
  render(() => (
    <MobileShell
      buffers={[buffer]}
      composerNotice={undefined}
      completion={undefined}
      initialBufferId={2}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSelectBuffer={() => {}}
      onSend={async () => true}
    />
  ));
  const shell = document.querySelector<HTMLElement>("[data-mobile-shell]");
  if (shell === null) throw new Error("mobile shell is missing");

  fireEvent.pointerDown(shell, {
    clientX: 5,
    isPrimary: true,
    pointerId: 10,
  });
  fireEvent.pointerMove(shell, { clientX: 20, pointerId: 10 });
  fireEvent.pointerMove(shell, { clientX: 900, pointerId: 10 });
  fireEvent.pointerUp(shell, { clientX: 900, pointerId: 10 });
  await Promise.resolve();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(back).toHaveBeenCalledOnce();
  expect(
    document.querySelector('[data-motion="completing"] [data-mobile-chat]'),
  ).not.toBeNull();

  window.dispatchEvent(new PopStateEvent("popstate"));
  await settledMotion();
  expect(back).toHaveBeenCalledOnce();
  expect(document.querySelector("[data-mobile-chat]")).toBeNull();
  expect(screen.getByRole("region", { name: "Chats" })).toBeVisible();
  back.mockRestore();
});

it("does not open members from a pan on a direct chat", () => {
  history.replaceState(null, "", "/Local/mel");
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true }) as MediaQueryList),
  );
  render(() => (
    <MobileShell
      buffers={[buffer]}
      composerNotice={undefined}
      completion={undefined}
      initialBufferId={2}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSelectBuffer={() => {}}
      onSend={async () => true}
    />
  ));
  const shell = document.querySelector<HTMLElement>("[data-mobile-shell]");
  if (shell === null) throw new Error("mobile shell is missing");
  vi.spyOn(shell, "getBoundingClientRect").mockReturnValue({
    bottom: 800,
    height: 800,
    left: 0,
    right: 400,
    toJSON: () => ({}),
    top: 0,
    width: 400,
    x: 0,
    y: 0,
  });

  fireEvent.pointerDown(shell, {
    clientX: 250,
    clientY: 300,
    isPrimary: true,
    pointerId: 9,
  });
  fireEvent.pointerMove(shell, { clientX: 230, clientY: 300, pointerId: 9 });
  fireEvent.pointerMove(shell, { clientX: 50, clientY: 300, pointerId: 9 });
  fireEvent.pointerUp(shell, { clientX: 50, clientY: 300, pointerId: 9 });

  expect(screen.queryByRole("dialog", { name: "Members" })).toBeNull();
});

it("replaces chat and drawer state in touch WebKit browser tabs", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches:
        query === "(prefers-reduced-motion: reduce)" ||
        query === "(pointer: coarse)",
    })) as unknown as typeof matchMedia,
  );
  vi.stubGlobal("WebKitPoint", class {});
  const push = vi.spyOn(window.history, "pushState");
  const replace = vi.spyOn(window.history, "replaceState");
  const back = vi.spyOn(window.history, "back");
  const channel = {
    ...buffer,
    id: 3,
    kind: "channel" as const,
    title: "#room",
  };

  try {
    render(() => (
      <MobileShell
        buffers={[channel]}
        composerNotice={undefined}
        completion={undefined}
        memberships={new Map()}
        messages={new Map()}
        networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
        onLoadHistory={() => {}}
        onMarkRead={() => {}}
        onRequestCompletion={() => {}}
        onSelectBuffer={() => {}}
        onSend={async () => true}
        pathForBuffer={() => "/Local/room"}
      />
    ));

    expect(document.querySelector("[data-mobile-shell]")).toHaveAttribute(
      "data-history-policy",
      "replace",
    );
    fireEvent.click(screen.getByRole("button", { name: "#room" }));
    expect(window.location.pathname).toBe("/Local/room");
    fireEvent.click(screen.getByRole("button", { name: "Show members" }));
    fireEvent.click(
      screen.getAllByRole("button", {
        name: "Close member list",
      })[0] as Element,
    );
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: "Back to chats" }));

    expect(screen.getByRole("region", { name: "Chats" })).toBeVisible();
    expect(window.location.pathname).toBe("/");
    expect(push).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  } finally {
    push.mockRestore();
    replace.mockRestore();
    back.mockRestore();
  }
});

async function settledMotion(): Promise<void> {
  await waitFor(() =>
    expect(document.querySelector("[data-motion]")).toBeNull(),
  );
}
