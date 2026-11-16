import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import type { BufferProjection } from "../../engine/protocol";
import {
  installPlatformEnvironment,
  type PlatformController,
} from "../../platform/environment";
import { DesktopShell } from "./DesktopShell";

const channel: BufferProjection = {
  id: 2,
  network_id: 1,
  sync_state: "synced" as const,
  kind: "channel",
  title: "#room",
  draft_key: "1:#room",
  topic: "Room topic",
  member_count: 7,
  unread: 0,
  mentions: 0,
};

let platform: PlatformController | undefined;

afterEach(() => platform?.dispose());

function installMacApp(fullScreen: boolean, width = 1024): void {
  vi.stubGlobal("__WEBLOUNGE_SHELL__", {
    kind: "macos-app",
    version: "0.2.0",
    windowControls: { inlineStart: 84, blockSize: 48 },
  });
  vi.stubGlobal("__TAURI_INTERNALS__", {
    invoke: (command: string) =>
      Promise.resolve(
        command === "plugin:window|is_fullscreen" ? fullScreen : null,
      ),
  });
  platform = installPlatformEnvironment(document.body, window, {
    observeWidth: (_element, onWidth) => {
      onWidth(width);
      return () => {};
    },
  });
}

function renderShell(): void {
  render(() => (
    <DesktopShell
      activeBufferId={channel.id}
      buffers={[channel]}
      composerNotice={undefined}
      completion={undefined}
      focusRequest={undefined}
      memberships={new Map()}
      messages={new Map()}
      networks={[
        { id: 1, label: "Local Ergo", nickname: "me", state: "online" },
      ]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSend={async () => true}
    />
  ));
}

function lightsRow(): HTMLElement | null {
  return document.querySelector("[data-sidebar-lights-row]");
}

function header(): HTMLElement | null {
  return document.querySelector("[data-main-header]");
}

function toggleSidebar(): void {
  fireEvent.click(screen.getByRole("button", { name: "Toggle channel list" }));
}

function brandButtons(): number {
  return (
    document
      .querySelector("[data-connection-brand]")
      ?.querySelectorAll("button").length ?? 0
  );
}

it("moves search and settings into a draggable lights row", () => {
  installMacApp(false);
  renderShell();

  const row = lightsRow();
  expect(row).toHaveAttribute("data-tauri-drag-region", "deep");
  expect(row?.querySelector('[aria-label="Settings"]')).not.toBeNull();
  expect(row?.querySelector("[data-switcher-launcher]")).not.toBeNull();
  expect(brandButtons()).toBe(0);
  expect(header()).toHaveAttribute("data-tauri-drag-region", "deep");
  expect(header()).not.toHaveAttribute("data-window-controls-inset");
});

it("insets the header for the lights while the sidebar is hidden", () => {
  installMacApp(false);
  renderShell();

  toggleSidebar();
  expect(header()).toHaveAttribute("data-window-controls-inset");
  expect(header()).toHaveAttribute("data-tauri-drag-region", "deep");
  toggleSidebar();
  expect(header()).not.toHaveAttribute("data-window-controls-inset");
});

it("insets the header and opens the drawer under the lights when narrow", () => {
  installMacApp(false, 400);
  renderShell();

  expect(header()).toHaveAttribute("data-window-controls-inset");
  expect(header()).toHaveAttribute("data-tauri-drag-region", "deep");
  toggleSidebar();
  const drawer = screen.getByRole("dialog", { name: "Channels" });
  expect(drawer.querySelector("[data-sidebar-lights-row]")).not.toBeNull();
});

it("gives the brand row its buttons back in full screen", async () => {
  installMacApp(true);
  renderShell();

  await waitFor(() => expect(lightsRow()).toBeNull());
  expect(brandButtons()).toBe(2);
  toggleSidebar();
  expect(header()).not.toHaveAttribute("data-tauri-drag-region");
  expect(header()).not.toHaveAttribute("data-window-controls-inset");
});

it("keeps the brand row's buttons in a plain browser", () => {
  renderShell();

  expect(lightsRow()).toBeNull();
  expect(brandButtons()).toBe(2);
  toggleSidebar();
  expect(header()).not.toHaveAttribute("data-tauri-drag-region");
  expect(header()).not.toHaveAttribute("data-window-controls-inset");
});
