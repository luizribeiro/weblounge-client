import { describe, expect, it, vi } from "vitest";
import { ActionRegistry } from "./action-registry";

const context = {
  bufferCount: 3,
  connected: true,
  features: [] as string[],
  listActive: false,
  permission: "anyone" as const,
};

describe("ActionRegistry", () => {
  it("dispatches platform-aware global and desktop bindings", () => {
    const switcher = vi.fn();
    const next = vi.fn();
    const registry = new ActionRegistry(
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
    const registry = new ActionRegistry({ "list.next": next }, "other");
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

  it("keeps buffer traversal out of text inputs", () => {
    const next = vi.fn();
    const previous = vi.fn();
    const registry = new ActionRegistry(
      { "buffer.next": next, "buffer.previous": previous },
      "other",
    );
    const input = document.createElement("input");
    const button = document.createElement("button");

    for (const key of ["ArrowUp", "ArrowDown"]) {
      expect(registry.handleKeydown(modifiedKeydown(key, input), context)).toBe(
        false,
      );
      expect(
        registry.handleKeydown(modifiedKeydown(key, button), context),
      ).toBe(true);
    }
    expect(previous).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not dispatch unavailable buffer traversal", () => {
    const next = vi.fn();
    const registry = new ActionRegistry({ "buffer.next": next }, "other");

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
    const registry = new ActionRegistry(
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

  it("merges UI actions and runtime commands for palette and help", () => {
    const registry = new ActionRegistry(
      { "settings.open": vi.fn() },
      "other",
      [command("join", ["slash", "palette"]), command("say", ["slash"])],
      vi.fn(),
    );

    expect(registry.palette(context).map(({ id }) => id)).toEqual([
      "settings.open",
      "command.join",
    ]);
    expect(registry.help(context).map(({ id }) => id)).toEqual([
      "settings.open",
      "command.join",
      "command.say",
    ]);
    expect(registry.palette(context)[1]?.title).toBe(
      "Join one or more channels",
    );
  });

  it("gates and runs commands through derived policy", () => {
    const run = vi.fn();
    const oper = {
      ...command("join", ["palette"]),
      permission: "oper" as const,
    };
    const registry = new ActionRegistry({}, "other", [oper], run);

    expect(registry.palette(context)).toEqual([]);
    const operContext = { ...context, permission: "oper" as const };
    expect(registry.run("command.join", operContext, "menu")).toBe("ran");
    expect(run).toHaveBeenCalledWith(oper, operContext);
  });

  it("applies always and menu confirmation by invocation source", () => {
    const run = vi.fn();
    const menu = {
      ...command("join", ["palette"]),
      confirm: "menu" as const,
    };
    const registry = new ActionRegistry({}, "other", [menu], run);

    expect(registry.run("command.join", context, "menu")).toBe(
      "confirmation_required",
    );
    expect(registry.run("command.join", context, "typed")).toBe("ran");
    expect(registry.run("command.join", context, "menu", true)).toBe("ran");
  });

  it("keeps viewport diagnostics hidden until the exact slash command", () => {
    const debug = vi.fn();
    const registry = new ActionRegistry({ "debug.viewport": debug }, "other");

    expect(registry.palette(context)).toEqual([]);
    expect(registry.help(context)).toEqual([]);
    expect(registry.completeInput("one", 7, "/deb", 4)).toBeUndefined();
    expect(registry.completeInput("two", 7, "/debug", 6)?.candidates).toEqual([
      expect.objectContaining({ type: "command", name: "debug" }),
    ]);
    expect(registry.runInput("/debug viewport", context)).toBe("ran");
    expect(debug).toHaveBeenLastCalledWith({
      ...context,
      debugViewport: true,
    });
    expect(registry.runInput("/debug off", context)).toBe("ran");
    expect(debug).toHaveBeenLastCalledWith({
      ...context,
      debugViewport: false,
    });
    expect(registry.runInput("/debug invalid", context)).toBe("ran");
    expect(debug).toHaveBeenLastCalledWith(context);
  });
});

function keydown(key: string, target: Element): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, cancelable: true });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

function modifiedKeydown(key: string, target: Element): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    altKey: true,
    cancelable: true,
  });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

function command(
  name: string,
  surfaces: ("slash" | "palette")[],
): import("../engine/protocol").CommandSpec {
  return {
    name,
    aliases: name === "join" ? ["j"] : [],
    arguments: [],
    usage: `cmd.${name}.usage`,
    description: `cmd.${name}.description`,
    requirements: [{ type: "connected" }],
    permission: "anyone",
    surfaces,
    confirm: "none",
    secret_arguments: false,
  };
}
