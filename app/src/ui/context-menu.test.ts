import { describe, expect, it, vi } from "vitest";
import { ContextMenuRegistry, installContextMenuHandler } from "./context-menu";

describe("context menu registry", () => {
  it("prevents the browser menu on registered chrome", () => {
    const registry = new ContextMenuRegistry();
    const chrome = document.createElement("button");
    document.body.append(chrome);
    registry.register(chrome, { id: "send", kind: "chrome" });
    const remove = installContextMenuHandler(document, registry);
    const event = contextMenu(chrome);

    expect(event.defaultPrevented).toBe(true);
    remove();
  });

  it("allows the browser menu on selectable content and inputs", () => {
    const registry = new ContextMenuRegistry();
    const content = document.createElement("span");
    const input = document.createElement("input");
    document.body.append(content, input);
    registry.register(content, { id: "message-text", kind: "selectable" });
    const remove = installContextMenuHandler(document, registry);

    expect(contextMenu(content).defaultPrevented).toBe(false);
    expect(contextMenu(input).defaultPrevented).toBe(false);
    remove();
  });

  it("removes registrations and the root handler", () => {
    const registry = new ContextMenuRegistry();
    const chrome = document.createElement("div");
    document.body.append(chrome);
    const unregister = registry.register(chrome, {
      id: "temporary",
      kind: "chrome",
    });
    const remove = installContextMenuHandler(document, registry);
    unregister();
    remove();
    const preventDefault = vi.spyOn(Event.prototype, "preventDefault");

    contextMenu(chrome);

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    { key: "F10", shiftKey: true },
    { key: "ContextMenu", shiftKey: false },
  ])("opens a registered menu from $key", ({ key, shiftKey }) => {
    const registry = new ContextMenuRegistry();
    const row = document.createElement("button");
    document.body.append(row);
    const openMenu = vi.fn();
    registry.register(row, { id: "row", kind: "chrome", openMenu });
    const remove = installContextMenuHandler(document, registry);
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
      shiftKey,
    });

    row.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(openMenu).toHaveBeenCalledWith(
      expect.objectContaining({ invoker: row }),
    );
    remove();
  });

  it("opens a registered menu from right-click", () => {
    const registry = new ContextMenuRegistry();
    const row = document.createElement("button");
    document.body.append(row);
    const openMenu = vi.fn();
    registry.register(row, { id: "row", kind: "chrome", openMenu });
    const remove = installContextMenuHandler(document, registry);

    contextMenu(row);

    expect(openMenu).toHaveBeenCalledWith(
      expect.objectContaining({ invoker: row }),
    );
    remove();
  });
});

function contextMenu(target: Element): MouseEvent {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  target.dispatchEvent(event);
  return event;
}
