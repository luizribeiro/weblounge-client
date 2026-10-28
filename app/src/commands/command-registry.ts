export type CommandId =
  | "buffer.next"
  | "buffer.open"
  | "buffer.previous"
  | "list.next"
  | "list.open"
  | "list.previous"
  | "members.toggle"
  | "network.add"
  | "network.open-server"
  | "pane.show-buffer"
  | "settings.open"
  | "sidebar.toggle"
  | "switcher.open";

export type CommandScope = "global" | "desktop" | "list";
export type Platform = "macos" | "other";

export interface CommandContext {
  readonly bufferCount: number;
  readonly listActive: boolean;
  readonly targetBufferId?: number;
  readonly targetNetworkId?: number;
}

export interface CommandAvailability {
  readonly state: "available" | "unavailable";
}

export type CommandHandler = (context: CommandContext) => void;

interface Binding {
  readonly key: string;
  readonly code?: string;
  readonly alt?: boolean;
  readonly mod?: boolean;
  readonly shift?: boolean;
  readonly scope: CommandScope;
  readonly label: Readonly<Record<Platform, string>>;
}

interface CommandSpec {
  readonly id: CommandId;
  readonly title: string;
  readonly availability: (context: CommandContext) => CommandAvailability;
  readonly binding?: Binding;
}

const alwaysAvailable = (): CommandAvailability => ({ state: "available" });
const needsBuffers = (context: CommandContext): CommandAvailability => ({
  state: context.bufferCount > 1 ? "available" : "unavailable",
});
const needsList = (context: CommandContext): CommandAvailability => ({
  state: context.listActive ? "available" : "unavailable",
});

const specs: readonly CommandSpec[] = [
  command(
    "switcher.open",
    "Jump to",
    alwaysAvailable,
    mod("k", "⌘K", "Ctrl+K"),
  ),
  command("settings.open", "Settings", alwaysAvailable, {
    ...mod(",", "⇧⌘,", "Ctrl+Shift+,"),
    shift: true,
  }),
  command("sidebar.toggle", "Toggle channel list", alwaysAvailable, {
    ...mod("s", "⌥⌘S", "Ctrl+Alt+S"),
    alt: true,
  }),
  command(
    "members.toggle",
    "Toggle member list",
    alwaysAvailable,
    mod(".", "⌘.", "Ctrl+."),
  ),
  command(
    "buffer.open",
    "Join a channel or start a direct message",
    alwaysAvailable,
    { ...mod("k", "⇧⌘K", "Ctrl+Shift+K"), shift: true },
  ),
  command("network.add", "Add network", alwaysAvailable),
  command("network.open-server", "Open server messages", alwaysAvailable),
  command("pane.show-buffer", "Show buffer", alwaysAvailable),
  command(
    "buffer.previous",
    "Previous buffer",
    needsBuffers,
    altKey("ArrowUp", "⌥↑", "Alt+↑", "desktop"),
  ),
  command(
    "buffer.next",
    "Next buffer",
    needsBuffers,
    altKey("ArrowDown", "⌥↓", "Alt+↓", "desktop"),
  ),
  command(
    "list.previous",
    "Previous item",
    needsList,
    key("ArrowUp", "↑", "list"),
  ),
  command("list.next", "Next item", needsList, key("ArrowDown", "↓", "list")),
  command("list.open", "Open item", needsList, key("Enter", "↵", "list")),
];

export class CommandRegistry {
  readonly #handlers: Readonly<Partial<Record<CommandId, CommandHandler>>>;
  readonly #platform: Platform;

  constructor(
    handlers: Readonly<Partial<Record<CommandId, CommandHandler>>>,
    platform: Platform,
  ) {
    this.#handlers = handlers;
    this.#platform = platform;
  }

  availability(id: CommandId, context: CommandContext): CommandAvailability {
    const spec = findSpec(id);
    if (this.#handlers[id] === undefined) return { state: "unavailable" };
    return spec.availability(context);
  }

  run(id: CommandId, context: CommandContext): boolean {
    if (this.availability(id, context).state !== "available") return false;
    this.#handlers[id]?.(context);
    return true;
  }

  title(id: CommandId): string {
    return findSpec(id).title;
  }

  bindingLabel(id: CommandId): string | undefined {
    return findSpec(id).binding?.label[this.#platform];
  }

  handleKeydown(event: KeyboardEvent, context: CommandContext): boolean {
    if (
      event.isComposing ||
      event.getModifierState("AltGraph") ||
      event.key === "Dead" ||
      event.key === "Process"
    ) {
      return false;
    }
    const scopes = activeScopes(event.target);
    const spec = specs.find(
      (candidate) =>
        candidate.binding !== undefined &&
        scopes.includes(candidate.binding.scope) &&
        matches(event, candidate.binding) &&
        this.availability(candidate.id, context).state === "available",
    );
    if (spec === undefined) return false;
    event.preventDefault();
    event.stopPropagation();
    return this.run(spec.id, context);
  }
}

export function detectPlatform(navigator: Navigator): Platform {
  return /Mac|iPhone|iPad/.test(navigator.platform) ? "macos" : "other";
}

function command(
  id: CommandId,
  title: string,
  availability: CommandSpec["availability"],
  binding?: Binding,
): CommandSpec {
  return binding === undefined
    ? { id, title, availability }
    : { id, title, availability, binding };
}

function mod(keyValue: string, macos: string, other: string): Binding {
  return {
    key: keyValue,
    mod: true,
    scope: "global",
    label: { macos, other },
  };
}

function altKey(
  keyValue: string,
  macos: string,
  other: string,
  scope: CommandScope,
): Binding {
  return { key: keyValue, alt: true, scope, label: { macos, other } };
}

function key(keyValue: string, label: string, scope: CommandScope): Binding {
  return { key: keyValue, scope, label: { macos: label, other: label } };
}

function findSpec(id: CommandId): CommandSpec {
  const spec = specs.find((candidate) => candidate.id === id);
  if (spec === undefined) throw new Error(`unknown command: ${id}`);
  return spec;
}

function activeScopes(target: EventTarget | null): readonly CommandScope[] {
  if (!(target instanceof Element)) return ["global", "desktop"];
  const list = target.closest('[data-command-scope="list"]') !== null;
  return list ? ["list", "desktop", "global"] : ["desktop", "global"];
}

function matches(event: KeyboardEvent, binding: Binding): boolean {
  const modPressed = binding.mod
    ? event.metaKey || event.ctrlKey
    : !event.metaKey && !event.ctrlKey;
  return (
    modPressed &&
    event.altKey === (binding.alt ?? false) &&
    event.shiftKey === (binding.shift ?? false) &&
    (binding.code === undefined
      ? event.key.toLocaleLowerCase() === binding.key.toLocaleLowerCase()
      : event.code === binding.code) &&
    !isTextInput(event.target, binding)
  );
}

function isTextInput(target: EventTarget | null, binding: Binding): boolean {
  if (!(target instanceof Element)) return false;
  if (binding.scope === "global") return false;
  return (
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
    ) !== null
  );
}
