import { createEffect, createSignal } from "solid-js";
import type { BufferKind } from "../../engine/generated/BufferKind";
import type { MemberWindow } from "../../features/members/MemberPanel";

export const memberColumnWidth = 232;
export const memberColumnWidthToken = "var(--wl-size-members)";
export const minConversationBesideMembers = 320;

export type MembersPresentation = "inline" | "drawer";

export function membersPresentation(paneWidth: number): MembersPresentation {
  return paneWidth >= memberColumnWidth + minConversationBesideMembers
    ? "inline"
    : "drawer";
}

export function memberWindowFor(
  window: MemberWindow | undefined,
  bufferId: number,
): MemberWindow | undefined {
  return window?.buffer_id === bufferId ? window : undefined;
}

export interface PaneMembersController {
  readonly toggle: () => void;
  readonly dismissDrawer: () => void;
}

interface PaneMembersOptions {
  readonly bufferKind: () => BufferKind | undefined;
  readonly shown: () => boolean;
  readonly onToggleShown: () => void;
  readonly onDrawerOpen: () => void;
  readonly focusComposer: () => void;
}

export function createPaneMembers(options: PaneMembersOptions) {
  const [width, setWidth] = createSignal(window.innerWidth);
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const presentation = () => membersPresentation(width());
  const available = () => options.bufferKind() === "channel";
  const inlineShown = () =>
    available() && presentation() === "inline" && options.shown();
  const drawerShown = () =>
    available() && presentation() === "drawer" && drawerOpen();
  const dismissDrawer = () => setDrawerOpen(false);
  const closeDrawer = () => {
    dismissDrawer();
    options.focusComposer();
  };
  createEffect(() => {
    if (drawerOpen() && !drawerShown()) dismissDrawer();
  });
  const toggle = () => {
    if (!available()) return;
    if (presentation() === "inline") {
      if (options.shown()) options.focusComposer();
      options.onToggleShown();
    } else if (drawerOpen()) {
      closeDrawer();
    } else {
      options.onDrawerOpen();
      setDrawerOpen(true);
    }
  };
  return {
    closeDrawer,
    controller: { dismissDrawer, toggle } satisfies PaneMembersController,
    drawerShown,
    inlineShown,
    pressed: () => inlineShown() || drawerShown(),
    setWidth,
  };
}

export function observePaneWidth(
  element: HTMLElement,
  onWidth: (width: number) => void,
): () => void {
  const observer = new ResizeObserver(([entry]) => {
    if (entry !== undefined) onWidth(entry.contentRect.width);
  });
  observer.observe(element);
  return () => observer.disconnect();
}
