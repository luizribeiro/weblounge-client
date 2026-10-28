import { describe, expect, it, vi } from "vitest";
import { CommandRegistry, detectPlatform } from "./command-registry";

const context = { bufferCount: 3, listActive: false };

describe("CommandRegistry", () => {
  it("dispatches platform-aware global and desktop bindings", () => {
    const switcher = vi.fn();
    const next = vi.fn();
    const registry = new CommandRegistry(
      { "switcher.open": switcher, "buffer.next": next },
      "macos",
    );
    const switcherEvent = new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      cancelable: true,
    });
    const nextEvent = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      cancelable: true,
    });

    expect(registry.handleKeydown(switcherEvent, context)).toBe(true);
    expect(registry.handleKeydown(nextEvent, context)).toBe(true);
    expect(switcher).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
    expect(registry.bindingLabel("switcher.open")).toBe("⌘K");
  });

  it("resolves list bindings only inside the list scope", () => {
    const next = vi.fn();
    const registry = new CommandRegistry({ "list.next": next }, "other");
    const outside = document.createElement("button");
    const list = document.createElement("div");
    list.dataset.commandScope = "list";
    const inside = document.createElement("button");
    list.append(inside);
    document.body.append(outside, list);

    expect(
      registry.handleKeydown(keydown("ArrowDown", outside), {
        ...context,
        listActive: true,
      }),
    ).toBe(false);
    expect(
      registry.handleKeydown(keydown("ArrowDown", inside), {
        ...context,
        listActive: true,
      }),
    ).toBe(true);
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not dispatch unavailable buffer traversal", () => {
    const next = vi.fn();
    const registry = new CommandRegistry({ "buffer.next": next }, "other");

    expect(
      registry.handleKeydown(
        new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true }),
        { bufferCount: 1, listActive: false },
      ),
    ).toBe(false);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes a clicked target through the typed command boundary", () => {
    const showBuffer = vi.fn();
    const registry = new CommandRegistry(
      { "pane.show-buffer": showBuffer },
      "other",
    );

    registry.run("pane.show-buffer", {
      ...context,
      targetBufferId: 42,
    });

    expect(showBuffer).toHaveBeenCalledWith({
      ...context,
      targetBufferId: 42,
    });
  });

  it("detects Apple shortcut labels", () => {
    expect(detectPlatform({ platform: "MacIntel" } as Navigator)).toBe("macos");
    expect(detectPlatform({ platform: "Linux x86_64" } as Navigator)).toBe(
      "other",
    );
  });
});

function keydown(key: string, target: Element): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, cancelable: true });
  Object.defineProperty(event, "target", { value: target });
  return event;
}
