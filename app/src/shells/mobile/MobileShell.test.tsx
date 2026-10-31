import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import type { BufferProjection } from "../../engine/protocol";
import { installPlatformEnvironment } from "../../platform/environment";
import { MobileShell } from "./MobileShell";

const buffer: BufferProjection = {
  id: 2,
  network_id: 1,
  kind: "direct",
  title: "mel",
  draft_key: "mel",
  topic: null,
  unread: 0,
  mentions: 0,
  read_through: null,
};

afterEach(() => window.history.replaceState({}, "", "/"));

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
  expect(fireEvent.pointerDown(shell, { clientX: 5, pointerId: 7 })).toBe(
    false,
  );
  fireEvent.pointerMove(shell, { clientX: 45, pointerId: 7 });
  fireEvent.pointerCancel(shell, { clientX: 45, pointerId: 7 });
  await settledMotion();
  expect(screen.getByRole("heading", { name: "mel" })).toBeVisible();
  window.dispatchEvent(new PopStateEvent("popstate"));
  await settledMotion();
  expect(screen.getByRole("region", { name: "Chats" })).toBeVisible();
  expect(screen.getByRole("button", { name: "mel" })).toBe(chatRow);
  expect(loadHistory).toHaveBeenCalledTimes(1);
  expect(document.querySelectorAll("[data-mobile-chat]")).toHaveLength(0);
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

  fireEvent.pointerDown(shell, { clientX: 5, pointerId: 7 });
  fireEvent.pointerMove(shell, { clientX: 100, pointerId: 7 });
  expect(document.querySelector('[data-motion="dragging"]')).not.toBeNull();
  window.dispatchEvent(new PopStateEvent("popstate"));
  fireEvent.pointerUp(shell, { clientX: 100, pointerId: 7 });
  expect(document.querySelector("[data-motion]")).toBeNull();
  expect(screen.getByRole("region", { name: "Chats" })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "mel" }));
  await settledMotion();
  fireEvent.pointerDown(shell, { clientX: 5, pointerId: 8 });
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

  fireEvent.pointerDown(shell, { clientX: 5, pointerId: 9 });
  fireEvent.pointerMove(shell, { clientX: 900, pointerId: 9 });
  fireEvent.pointerUp(shell, { clientX: 900, pointerId: 9 });
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

  fireEvent.pointerDown(shell, { clientX: 5, pointerId: 10 });
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

  fireEvent.pointerDown(shell, { clientX: 250, clientY: 300, pointerId: 9 });
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
