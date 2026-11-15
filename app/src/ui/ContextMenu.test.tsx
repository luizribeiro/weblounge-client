import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu, contextMenuPosition } from "./ContextMenu";
import type { ContextMenuRequest } from "./context-menu";

describe("ContextMenu", () => {
  it("moves through items, activates one, and restores the invoker", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { invoker, open } = setup(first, second);

    open();
    const items = await screen.findAllByRole("menuitem");
    await waitFor(() => expect(items[0]).toHaveFocus());
    fireEvent.keyDown(items[0] as HTMLElement, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1] as HTMLElement, { key: "Enter" });

    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(invoker).toHaveFocus();
  });

  it("wraps arrow focus and restores focus on Escape", async () => {
    const { invoker, open } = setup(vi.fn(), vi.fn());

    open();
    const items = await screen.findAllByRole("menuitem");
    await waitFor(() => expect(items[0]).toHaveFocus());
    fireEvent.keyDown(items[0] as HTMLElement, { key: "ArrowUp" });
    expect(items[1]).toHaveFocus();
    invoker.focus();
    fireEvent.keyDown(invoker, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(invoker).toHaveFocus();
  });

  it("reserves a separated destructive group", async () => {
    const invoker = document.createElement("button");
    document.body.append(invoker);
    render(() => (
      <ContextMenu
        destructiveItems={[{ id: "close", label: "Close", onSelect: vi.fn() }]}
        items={[{ id: "read", label: "Mark as read", onSelect: vi.fn() }]}
        label="Conversation actions"
        onDismiss={() => {}}
        request={{ invoker, x: 0, y: 0 }}
      />
    ));

    expect(await screen.findByRole("separator")).toBeInTheDocument();
  });

  it("separates nothing when the destructive group is the whole menu", async () => {
    const invoker = document.createElement("button");
    document.body.append(invoker);
    render(() => (
      <ContextMenu
        destructiveItems={[
          { id: "delete", label: "Delete", onSelect: vi.fn() },
        ]}
        items={[]}
        label="Message actions"
        onDismiss={() => {}}
        request={{ invoker, x: 0, y: 0 }}
      />
    ));

    expect(
      await screen.findByRole("menuitem", { name: "Delete" }),
    ).toBeVisible();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("keeps a menu opened near the right edge inside the viewport", async () => {
    const invoker = document.createElement("button");
    document.body.append(invoker);
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const sized = this.isConnected && this.childElementCount > 0;
        return new DOMRect(0, 0, sized ? 210 : 0, sized ? 40 : 0);
      });
    try {
      render(() => (
        <ContextMenu
          items={[{ id: "read", label: "Mark as read", onSelect: vi.fn() }]}
          label="Actions"
          onDismiss={() => {}}
          request={{ invoker, x: window.innerWidth - 10, y: 10 }}
        />
      ));

      const menu = await screen.findByRole("menu");
      await waitFor(() =>
        expect(menu.style.getPropertyValue("--wl-context-menu-left")).toBe(
          `${window.innerWidth - 214}px`,
        ),
      );
    } finally {
      rect.mockRestore();
    }
  });
});

it("keeps the menu inside the viewport", () => {
  expect(
    contextMenuPosition(
      { x: 190, y: 90 },
      { width: 100, height: 50 },
      { innerWidth: 200, innerHeight: 100 },
    ),
  ).toEqual({ left: 96, top: 46 });
});

function setup(first: () => void, second: () => void) {
  const invoker = document.createElement("button");
  document.body.append(invoker);
  const [request, setRequest] = createSignal<ContextMenuRequest>();
  render(() => (
    <ContextMenu
      items={[
        { id: "first", label: "First", onSelect: first },
        { id: "second", label: "Second", onSelect: second },
      ]}
      label="Conversation actions"
      onDismiss={() => setRequest(undefined)}
      request={request()}
    />
  ));
  return {
    invoker,
    open: () => setRequest({ invoker, x: 10, y: 10 }),
  };
}
