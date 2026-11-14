import { describe, expect, it, vi } from "vitest";
import {
  ActionRegistry,
  type ActionShell,
  type Platform,
} from "./action-registry";

const context = {
  bufferCount: 3,
  connected: true,
  currentBufferKind: "channel" as const,
  features: [] as string[],
  listActive: false,
  permission: "anyone" as const,
};

describe("ActionRegistry", () => {
  it("dispatches platform-aware global and desktop bindings", () => {
    const members = vi.fn();
    const next = vi.fn();
    const registry = new ActionRegistry(
      { "members.toggle": members, "buffer.next": next },
      "macos",
    );
    const membersEvent = new KeyboardEvent("keydown", {
      key: ".",
      metaKey: true,
      cancelable: true,
    });
    const nextEvent = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      cancelable: true,
    });

    expect(registry.handleKeydown(membersEvent, context)).toBe(true);
    expect(registry.handleKeydown(nextEvent, context)).toBe(true);
    expect(members).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
    expect(registry.bindingLabel("members.toggle")).toBe("⌘.");
  });

  it("does not advertise or bind placeholder actions", () => {
    const settings = vi.fn();
    const registry = new ActionRegistry(
      {
        "network.add": vi.fn(),
        "settings.open": settings,
      },
      "macos",
    );

    expect(registry.bindingLabel("settings.open")).toBeUndefined();
    expect(registry.help(context).map(({ id }) => id)).not.toEqual(
      expect.arrayContaining(["network.add", "settings.open"]),
    );
    expect(settings).not.toHaveBeenCalled();
  });

  it("opens the discoverable switcher from the platform chord", () => {
    const switcher = vi.fn();
    const registry = new ActionRegistry({ "switcher.open": switcher }, "macos");

    expect(registry.bindingLabel("switcher.open")).toBe("⌘K");
    expect(registry.help(context).map(({ id }) => id)).toContain(
      "switcher.open",
    );
    expect(
      registry.handleKeydown(
        new KeyboardEvent("keydown", {
          key: "k",
          metaKey: true,
          cancelable: true,
        }),
        context,
      ),
    ).toBe(true);
    expect(switcher).toHaveBeenCalledOnce();
  });

  it("uses the native palette chord only in Tauri and the safe web fallback", () => {
    const nativeOpen = vi.fn();
    const webOpen = vi.fn();
    const native = new ActionRegistry(
      { "palette.open": nativeOpen },
      "other",
      [],
      undefined,
      "tauri",
    );
    const web = new ActionRegistry(
      { "palette.open": webOpen },
      "other",
      [],
      undefined,
      "web",
    );

    expect(native.bindingLabel("palette.open")).toBe("Ctrl+Shift+P");
    expect(web.bindingLabel("palette.open")).toBe("Ctrl+Shift+.");
    expect(
      native.handleKeydown(
        new KeyboardEvent("keydown", {
          key: "p",
          ctrlKey: true,
          shiftKey: true,
        }),
        context,
      ),
    ).toBe(true);
    expect(
      web.handleKeydown(
        new KeyboardEvent("keydown", {
          key: ".",
          ctrlKey: true,
          shiftKey: true,
        }),
        context,
      ),
    ).toBe(true);
    expect(nativeOpen).toHaveBeenCalledOnce();
    expect(webOpen).toHaveBeenCalledOnce();
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

  describe("conversation jumps", () => {
    const jumpContext = { ...context, conversationCount: 4 };
    const jumpRegistry = (platform: Platform, shell: ActionShell) => {
      const third = vi.fn();
      const registry = new ActionRegistry(
        { "buffer.jump-3": third, "buffer.jump-9": vi.fn() },
        platform,
        [],
        undefined,
        shell,
      );
      return { registry, third };
    };
    const digit = (
      slot: number,
      modifiers: KeyboardEventInit,
      target: Element = document.createElement("textarea"),
    ) => {
      const event = new KeyboardEvent("keydown", {
        code: `Digit${slot}`,
        key: modifiers.altKey === true ? "™" : String(slot),
        cancelable: true,
        ...modifiers,
      });
      Object.defineProperty(event, "target", { value: target });
      return event;
    };

    it.each([
      ["macos", "tauri", { metaKey: true }, "⌘3"],
      ["linux", "tauri", { ctrlKey: true }, "Ctrl+3"],
      ["other", "tauri", { ctrlKey: true }, "Ctrl+3"],
      ["macos", "web", { altKey: true }, "⌥3"],
      ["other", "web", { altKey: true }, "Alt+3"],
      ["linux", "web", { ctrlKey: true, altKey: true }, "Ctrl+Alt+3"],
    ] as const)(
      "binds %s %s by physical digit, even from the composer",
      (platform, shell, modifiers, label) => {
        const { registry, third } = jumpRegistry(platform, shell);

        expect(registry.bindingLabel("buffer.jump-3")).toBe(label);
        expect(registry.handleKeydown(digit(3, modifiers), jumpContext)).toBe(
          true,
        );
        expect(third).toHaveBeenCalledOnce();
      },
    );

    it("leaves browser-owned chords alone on the web", () => {
      const linux = jumpRegistry("linux", "web");
      const windows = jumpRegistry("other", "web");

      expect(
        linux.registry.handleKeydown(digit(3, { altKey: true }), jumpContext),
      ).toBe(false);
      expect(
        windows.registry.handleKeydown(
          digit(3, { ctrlKey: true }),
          jumpContext,
        ),
      ).toBe(false);
      expect(linux.third).not.toHaveBeenCalled();
      expect(windows.third).not.toHaveBeenCalled();
    });

    it("never captures AltGraph", () => {
      const { registry, third } = jumpRegistry("other", "web");
      const event = digit(3, { altKey: true, ctrlKey: true });
      Object.defineProperty(event, "getModifierState", {
        value: (key: string) => key === "AltGraph",
      });

      expect(registry.handleKeydown(event, jumpContext)).toBe(false);
      expect(third).not.toHaveBeenCalled();
    });

    it("passes the key through when no conversation sits in that slot", () => {
      const { registry } = jumpRegistry("macos", "web");
      const event = digit(9, { altKey: true });

      expect(registry.handleKeydown(event, jumpContext)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    });

    it("matches a jump chord without needing a row in that slot", () => {
      const { registry } = jumpRegistry("macos", "tauri");

      expect(
        registry.matchesBinding("buffer.jump-9", digit(9, { metaKey: true })),
      ).toBe(true);
      expect(
        registry.matchesBinding("buffer.jump-9", digit(8, { metaKey: true })),
      ).toBe(false);
      expect(
        registry.matchesBinding(
          "buffer.jump-9",
          digit(9, { metaKey: true, shiftKey: true }),
        ),
      ).toBe(false);
    });

    it("never matches a jump chord typed with AltGraph", () => {
      const { registry } = jumpRegistry("linux", "web");
      const event = digit(3, { altKey: true, ctrlKey: true });

      expect(registry.matchesBinding("buffer.jump-3", event)).toBe(true);
      Object.defineProperty(event, "getModifierState", {
        value: (key: string) => key === "AltGraph",
      });
      expect(registry.matchesBinding("buffer.jump-3", event)).toBe(false);
    });

    it.each([
      ["macos", "tauri", { alt: false, ctrl: false, meta: true, shift: false }],
      ["other", "tauri", { alt: false, ctrl: true, meta: false, shift: false }],
      ["macos", "web", { alt: true, ctrl: false, meta: false, shift: false }],
      ["linux", "web", { alt: true, ctrl: true, meta: false, shift: false }],
    ] as const)(
      "reports the %s %s jump modifiers for hints",
      (platform, shell, chord) => {
        expect(
          jumpRegistry(platform, shell).registry.modifierChord("buffer.jump-1"),
        ).toEqual(chord);
      },
    );
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
      { "members.toggle": vi.fn() },
      "other",
      [command("join", ["slash", "palette"]), command("say", ["slash"])],
      vi.fn(),
    );

    expect(registry.palette(context).map(({ id }) => id)).toEqual([
      "members.toggle",
      "command.join",
    ]);
    expect(registry.help(context).map(({ id }) => id)).toEqual([
      "members.toggle",
      "command.join",
      "command.say",
    ]);
    expect(registry.palette(context)[1]?.title).toBe(
      "Join one or more channels",
    );
  });

  it("omits hidden, unavailable, targeted, and argument-taking palette actions", () => {
    const join = {
      ...command("join", ["slash", "palette"]),
      arguments: [
        { name: "channels", kind: "channel_list" as const, required: true },
      ],
    };
    const registry = new ActionRegistry(
      {
        "members.toggle": vi.fn(),
        "network.add": vi.fn(),
        "network.open-server": vi.fn(),
        "settings.open": vi.fn(),
      },
      "other",
      [join],
      vi.fn(),
    );

    expect(
      registry.palette({ ...context, currentBufferKind: "direct" }),
    ).toEqual([]);
    expect(registry.help(context).map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "members.toggle",
        "network.open-server",
        "command.join",
      ]),
    );
  });

  it("shows implicit channel commands only while a channel is focused", () => {
    const topic = {
      ...command("topic", ["slash", "palette"]),
      arguments: [
        { name: "channel", kind: "channel" as const, required: false },
        { name: "text", kind: "text" as const, required: false },
      ],
    };
    const registry = new ActionRegistry({}, "other", [topic], vi.fn());

    expect(registry.palette(context).map(({ id }) => id)).toContain(
      "command.topic",
    );
    expect(
      registry.palette({ ...context, currentBufferKind: "direct" }),
    ).toEqual([]);
    const { currentBufferKind: _, ...noBuffer } = context;
    expect(registry.palette(noBuffer)).toEqual([]);
  });

  it("gates the channel menu by target state and command metadata", () => {
    const markRead = vi.fn();
    const leave = {
      ...command("part", ["channel_menu"]),
      confirm: "menu" as const,
    };
    const cycle = implicitChannelCommand("cycle");
    const topic = {
      ...implicitChannelCommand("topic"),
      menu_label: "cmd.topic.menu",
    };
    const registry = new ActionRegistry(
      { "buffer.mark-read": markRead },
      "other",
      [cycle, topic, leave, command("join", ["network_menu"])],
      vi.fn(),
    );

    const unreadMenu = registry.channelMenu({
      ...context,
      targetUnread: true,
    });
    expect(unreadMenu.map(({ id }) => id)).toEqual([
      "buffer.mark-read",
      "command.topic",
    ]);
    expect(unreadMenu.map(({ title }) => title)).toEqual([
      "Mark as read",
      "Edit topic…",
    ]);
    expect(registry.title("buffer.mark-read")).toBe(
      "Mark the current conversation as read",
    );
    expect(registry.channelMenu(context).map(({ id }) => id)).toEqual([
      "command.topic",
    ]);
    expect(
      registry.help(context).find(({ id }) => id === "command.topic")?.title,
    ).toBe("Show or change the channel topic");
    expect(
      registry.channelMenu({ ...context, currentBufferKind: "direct" }),
    ).toEqual([]);
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

  it("offers Leave for channels and unconfirmed Close for direct messages", () => {
    const close = {
      ...command("close", ["palette", "channel_menu"]),
      menu_label: "cmd.close.menu",
      confirm: "menu" as const,
    };
    const part = {
      ...command("part", ["palette", "channel_menu"]),
      menu_label: "cmd.part.menu",
      confirm: "menu" as const,
    };
    const run = vi.fn();
    const registry = new ActionRegistry({}, "other", [close, part], run);

    expect(registry.channelMenu(context).map(({ title }) => title)).toEqual([
      "Leave channel",
    ]);
    const direct = { ...context, currentBufferKind: "direct" as const };
    expect(registry.channelMenu(direct).map(({ title }) => title)).toEqual([
      "Close conversation",
    ]);
    expect(registry.run("command.close", direct, "menu")).toBe("ran");
    expect(registry.run("command.part", context, "menu")).toBe(
      "confirmation_required",
    );
  });

  it("keeps viewport diagnostics hidden until the exact slash command", () => {
    const debug = vi.fn();
    const registry = new ActionRegistry({ "debug.overlay": debug }, "other");

    expect(registry.palette(context)).toEqual([]);
    expect(registry.help(context)).toEqual([]);
    expect(registry.completeInput("one", 7, "/deb", 4)).toBeUndefined();
    expect(registry.completeInput("two", 7, "/debug", 6)?.candidates).toEqual([
      expect.objectContaining({ type: "command", name: "debug" }),
    ]);
    expect(registry.runInput("/debug", context)).toBe("ran");
    expect(debug).toHaveBeenLastCalledWith({
      ...context,
      debugOverlay: "summary",
    });
    expect(registry.runInput("/debug viewport", context)).toBe("ran");
    expect(debug).toHaveBeenLastCalledWith({
      ...context,
      debugOverlay: "viewport",
    });
    expect(registry.runInput("/debug gestures", context)).toBe("ran");
    expect(debug).toHaveBeenLastCalledWith({
      ...context,
      debugOverlay: "gestures",
    });
    expect(registry.runInput("/debug keyboard", context)).toBe("ran");
    expect(debug).toHaveBeenLastCalledWith({
      ...context,
      debugOverlay: "keyboard",
    });
    expect(registry.runInput("/debug push", context)).toBe("ran");
    expect(debug).toHaveBeenLastCalledWith({
      ...context,
      debugOverlay: "push",
    });
    expect(registry.runInput("/debug off", context)).toBe("ran");
    expect(debug).toHaveBeenLastCalledWith({
      ...context,
      debugOverlay: "off",
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
  surfaces: import("../engine/protocol").CommandSpec["surfaces"],
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

function implicitChannelCommand(
  name: string,
): import("../engine/protocol").CommandSpec {
  return {
    ...command(name, ["channel_menu"]),
    arguments: [{ name: "channel", kind: "channel", required: false }],
  };
}
