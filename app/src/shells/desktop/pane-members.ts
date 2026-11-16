import { createEffect, createSignal } from "solid-js";
import type { BufferKind } from "../../engine/generated/BufferKind";
import type { MemberWindow } from "../../features/members/MemberPanel";

export const memberColumnWidth = 232;
export const memberColumnWidthToken = "var(--wl-size-members)";
export const minConversationBesideMembers = 480;

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

type DrawerState = "closed" | "open" | "closing";

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
  const [drawer, setDrawer] = createSignal<DrawerState>("closed");
  const presentation = () => membersPresentation(width());
  const available = () => options.bufferKind() === "channel";
  const inlineShown = () =>
    available() && presentation() === "inline" && options.shown();
  const drawerShown = () =>
    available() && presentation() === "drawer" && drawer() !== "closed";
  const drawerClosing = () => drawerShown() && drawer() === "closing";
  const dismissDrawer = () => setDrawer("closed");
  const slideDrawerClosed = () => {
    if (drawer() === "open") setDrawer("closing");
  };
  const closeDrawer = () => {
    dismissDrawer();
    options.focusComposer();
  };
  createEffect(() => {
    if (drawer() !== "closed" && !drawerShown()) dismissDrawer();
  });
  const toggle = () => {
    if (!available()) return;
    if (presentation() === "inline") {
      if (options.shown()) options.focusComposer();
      options.onToggleShown();
    } else if (drawer() === "closed") {
      options.onDrawerOpen();
      setDrawer("open");
    } else {
      slideDrawerClosed();
    }
  };
  return {
    closeDrawer,
    controller: { dismissDrawer, toggle } satisfies PaneMembersController,
    drawerClosing,
    drawerShown,
    inlineShown,
    pressed: () => inlineShown() || (drawerShown() && !drawerClosing()),
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
