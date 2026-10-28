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

it("commits reduced-motion stack changes without transition neighbours", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true }) as MediaQueryList),
  );
  render(() => (
    <MobileShell
      buffers={[buffer]}
      composerNotice={undefined}
      completion={undefined}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={vi.fn()}
      onMarkRead={vi.fn()}
      onRequestCompletion={vi.fn()}
      onSelectBuffer={vi.fn()}
      onSend={async () => true}
    />
  ));

  fireEvent.click(screen.getByRole("button", { name: "mel" }));
  expect(screen.getByRole("heading", { name: "mel" })).toBeVisible();
  expect(document.querySelectorAll("[data-mobile-chats]")).toHaveLength(0);
  const shell = document.querySelector<HTMLElement>("[data-mobile-shell]");
  if (shell === null) throw new Error("mobile shell is missing");
  fireEvent.pointerDown(shell, { clientX: 5, pointerId: 7 });
  fireEvent.pointerMove(shell, { clientX: 45, pointerId: 7 });
  fireEvent.pointerCancel(shell, { clientX: 45, pointerId: 7 });
  expect(document.querySelector("[data-swipe]")).toBeNull();
  expect(screen.getByRole("heading", { name: "mel" })).toBeVisible();
  window.dispatchEvent(new PopStateEvent("popstate"));
  expect(screen.getByRole("region", { name: "Chats" })).toBeVisible();
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
