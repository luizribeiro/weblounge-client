import { render, waitFor } from "@solidjs/testing-library";
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

function installMacApp(fullScreen: boolean): void {
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
  platform = installPlatformEnvironment(document.body, window);
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
});

it("gives the brand row its buttons back in full screen", async () => {
  installMacApp(true);
  renderShell();

  await waitFor(() => expect(lightsRow()).toBeNull());
  expect(brandButtons()).toBe(2);
});

it("keeps the brand row's buttons in a plain browser", () => {
  renderShell();

  expect(lightsRow()).toBeNull();
  expect(brandButtons()).toBe(2);
});
