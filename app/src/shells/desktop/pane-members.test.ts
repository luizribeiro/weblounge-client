import { readFileSync } from "node:fs";
import { createRoot, createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import type { BufferKind } from "../../engine/generated/BufferKind";
import type { MemberWindow } from "../../features/members/MemberPanel";
import type { DesktopPanels } from "../../platform/environment";
import {
  createPaneMembers,
  memberColumnWidth,
  memberColumnWidthToken,
  membersPresentation,
  memberWindowFor,
  minConversationBesideMembers,
} from "./pane-members";

const threshold = memberColumnWidth + minConversationBesideMembers;

it("matches the token that sizes the member column and its drawer", () => {
  const css = readFileSync("src/styles/base.css", "utf8");
  const declarations = [...css.matchAll(/--wl-size-members:\s*(\d+)px;/gu)];
  expect(declarations.map((match) => Number(match[1]))).toEqual([
    memberColumnWidth,
  ]);
  expect(memberColumnWidthToken).toBe("var(--wl-size-members)");
});

it("shows members inline once the conversation keeps its minimum width", () => {
  expect(threshold).toBe(712);
  expect(membersPresentation(threshold, "inline")).toBe("inline");
  expect(membersPresentation(1216, "inline")).toBe("inline");
});

it("falls back to a drawer when the pane is narrower", () => {
  expect(membersPresentation(threshold - 1, "inline")).toBe("drawer");
  expect(membersPresentation(0, "inline")).toBe("drawer");
});

it("keeps the drawer while the window is too narrow for an inline sidebar", () => {
  expect(membersPresentation(threshold, "overlay")).toBe("drawer");
  expect(membersPresentation(1216, "overlay")).toBe("drawer");
});

it("only hands a pane the member window of the buffer it shows", () => {
  const window = { buffer_id: 2 } as MemberWindow;
  expect(memberWindowFor(window, 2)).toBe(window);
  expect(memberWindowFor(window, 3)).toBeUndefined();
  expect(memberWindowFor(undefined, 2)).toBeUndefined();
});

function paneMembers(width: number, kind: BufferKind = "channel") {
  return createRoot((dispose) => {
    const [bufferKind, setBufferKind] = createSignal<BufferKind | undefined>(
      kind,
    );
    const [desktopPanels, setDesktopPanels] =
      createSignal<DesktopPanels>("inline");
    const [shown, setShown] = createSignal(false);
    const options = {
      focusComposer: vi.fn(),
      onDrawerOpen: vi.fn(),
      onToggleShown: vi.fn(() => setShown((current) => !current)),
    };
    const members = createPaneMembers({
      ...options,
      bufferKind,
      desktopPanels,
      shown,
    });
    members.setWidth(width);
    return { dispose, members, options, setBufferKind, setDesktopPanels };
  });
}

it("toggles the channel's inline visibility and focuses the composer on close", () => {
  const { dispose, members, options } = paneMembers(1200);
  members.controller.toggle();
  expect(members.inlineShown()).toBe(true);
  expect(members.pressed()).toBe(true);
  expect(options.focusComposer).not.toHaveBeenCalled();
  members.controller.toggle();
  expect(members.inlineShown()).toBe(false);
  expect(options.focusComposer).toHaveBeenCalledOnce();
  expect(options.onDrawerOpen).not.toHaveBeenCalled();
  dispose();
});

it("opens a transient drawer in a narrow pane without changing visibility", () => {
  const { dispose, members, options } = paneMembers(500);
  members.controller.toggle();
  expect(members.drawerShown()).toBe(true);
  expect(members.inlineShown()).toBe(false);
  expect(options.onDrawerOpen).toHaveBeenCalledOnce();
  expect(options.onToggleShown).not.toHaveBeenCalled();
  dispose();
});

it("lets the drawer slide closed from the toggle before it unmounts", () => {
  const { dispose, members, options } = paneMembers(500);
  members.controller.toggle();
  members.controller.toggle();
  expect(members.drawerShown()).toBe(true);
  expect(members.drawerClosing()).toBe(true);
  expect(members.pressed()).toBe(false);
  members.controller.toggle();
  expect(members.drawerClosing()).toBe(true);
  expect(options.onDrawerOpen).toHaveBeenCalledOnce();
  expect(options.focusComposer).not.toHaveBeenCalled();
  members.closeDrawer();
  expect(members.drawerShown()).toBe(false);
  expect(members.drawerClosing()).toBe(false);
  expect(options.focusComposer).toHaveBeenCalledOnce();
  members.controller.toggle();
  expect(members.drawerShown()).toBe(true);
  expect(members.pressed()).toBe(true);
  dispose();
});

it("dismisses the drawer silently for another drawer, a wider pane or a DM", () => {
  const { dispose, members, options, setBufferKind } = paneMembers(500);
  members.controller.toggle();
  members.controller.dismissDrawer();
  expect(members.drawerShown()).toBe(false);

  members.controller.toggle();
  members.setWidth(1200);
  expect(members.drawerShown()).toBe(false);
  members.setWidth(500);
  expect(members.drawerShown()).toBe(false);

  members.controller.toggle();
  setBufferKind("direct");
  setBufferKind("channel");
  expect(members.drawerShown()).toBe(false);
  expect(options.focusComposer).not.toHaveBeenCalled();
  dispose();
});

it("hides the inline list while the sidebar collapses and restores it after", () => {
  const { dispose, members, setDesktopPanels } = paneMembers(1200);
  members.controller.toggle();
  setDesktopPanels("overlay");
  expect(members.inlineShown()).toBe(false);
  members.controller.toggle();
  expect(members.drawerShown()).toBe(true);
  setDesktopPanels("inline");
  expect(members.drawerShown()).toBe(false);
  expect(members.inlineShown()).toBe(true);
  dispose();
});

it.each<BufferKind>(["direct", "server"])(
  "ignores the toggle in a %s pane",
  (kind) => {
    const { dispose, members, options } = paneMembers(1200, kind);
    members.controller.toggle();
    expect(members.pressed()).toBe(false);
    expect(options.onToggleShown).not.toHaveBeenCalled();
    dispose();
  },
);
