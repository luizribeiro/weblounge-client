import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import type { BufferProjection } from "../../engine/protocol";
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

it("keeps the chat list mounted without reloading history", () => {
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
  expect(chatRow).toBeInTheDocument();
  expect(chatRow.closest("[data-retained]")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  expect(loadHistory).toHaveBeenCalledTimes(1);
  const shell = document.querySelector<HTMLElement>("[data-mobile-shell]");
  if (shell === null) throw new Error("mobile shell is missing");
  fireEvent.pointerDown(shell, { clientX: 5, pointerId: 7 });
  fireEvent.pointerMove(shell, { clientX: 45, pointerId: 7 });
  fireEvent.pointerCancel(shell, { clientX: 45, pointerId: 7 });
  expect(document.querySelector("[data-swipe]")).toBeNull();
  expect(screen.getByRole("heading", { name: "mel" })).toBeVisible();
  window.dispatchEvent(new PopStateEvent("popstate"));
  expect(screen.getByRole("region", { name: "Chats" })).toBeVisible();
  expect(screen.getByRole("button", { name: "mel" })).toBe(chatRow);
  expect(loadHistory).toHaveBeenCalledTimes(1);
  expect(document.querySelectorAll("[data-mobile-chat]")).toHaveLength(0);
});

it("closes the member drawer before popping the chat", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true }) as MediaQueryList),
  );
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
  window.dispatchEvent(new PopStateEvent("popstate"));
  expect(screen.queryByRole("dialog", { name: "Members" })).toBeNull();
  expect(screen.getByRole("heading", { name: "#room" })).toBeVisible();
  window.dispatchEvent(new PopStateEvent("popstate"));
  expect(screen.getByRole("region", { name: "Chats" })).toBeVisible();
});

it("clears an in-flight swipe when browser history or visibility wins", () => {
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
  expect(document.querySelector("[data-swipe]")).not.toBeNull();
  window.dispatchEvent(new PopStateEvent("popstate"));
  fireEvent.pointerUp(shell, { clientX: 100, pointerId: 7 });
  expect(document.querySelector("[data-swipe]")).toBeNull();
  expect(screen.getByRole("region", { name: "Chats" })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "mel" }));
  const chat = document.querySelector("[data-mobile-chat]");
  if (chat === null) throw new Error("mobile chat is missing");
  const chatScreen = chat.parentElement;
  if (chatScreen === null) throw new Error("mobile chat screen is missing");
  fireEvent.animationEnd(chatScreen);
  fireEvent.pointerDown(shell, { clientX: 5, pointerId: 8 });
  fireEvent.pointerMove(shell, { clientX: 100, pointerId: 8 });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(document.querySelector("[data-swipe]")).toBeNull();
  expect(screen.getByRole("heading", { name: "mel" })).toBeVisible();
});
