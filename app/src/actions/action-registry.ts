export type ActionId =
  | "buffer.next"
  | "buffer.open"
  | "buffer.previous"
  | "list.next"
  | "list.open"
  | "list.previous"
  | "members.toggle"
  | "message.jump-bottom"
  | "network.add"
  | "network.open-server"
  | "pane.show-buffer"
  | "settings.open"
  | "sidebar.toggle"
  | "switcher.open";

export type ActionScope = "global" | "desktop" | "list";
export type Platform = "macos" | "other";

export interface ActionContext {
  readonly bufferCount: number;
  readonly listActive: boolean;
  readonly targetBufferId?: number;
  readonly targetNetworkId?: number;
}

export interface ActionAvailability {
  readonly state: "available" | "unavailable";
}

export type ActionHandler = (context: ActionContext) => void;

interface Binding {
  readonly key: string;
  readonly code?: string;
  readonly alt?: boolean;
  readonly mod?: boolean;
  readonly shift?: boolean;
  readonly scope: ActionScope;
  readonly input: "never" | "nonText" | "emptyComposer" | "always";
  readonly label: Readonly<Record<Platform, string>>;
}

interface ActionSpec {
  readonly id: ActionId;
  readonly title: string;
  readonly availability: (context: ActionContext) => ActionAvailability;
  readonly binding?: Binding;
}

const alwaysAvailable = (): ActionAvailability => ({ state: "available" });
const needsBuffers = (context: ActionContext): ActionAvailability => ({
  state: context.bufferCount > 1 ? "available" : "unavailable",
});
const needsList = (context: ActionContext): ActionAvailability => ({
  state: context.listActive ? "available" : "unavailable",
});

const specs: readonly ActionSpec[] = [
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
  command(
    "message.jump-bottom",
    "Jump to latest message",
    alwaysAvailable,
    key("End", "End", "desktop"),
  ),
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

export class ActionRegistry {
  readonly #handlers: Readonly<Partial<Record<ActionId, ActionHandler>>>;
  readonly #platform: Platform;

  constructor(
    handlers: Readonly<Partial<Record<ActionId, ActionHandler>>>,
    platform: Platform,
  ) {
    this.#handlers = handlers;
    this.#platform = platform;
  }

  availability(id: ActionId, context: ActionContext): ActionAvailability {
    const spec = findSpec(id);
    if (this.#handlers[id] === undefined) return { state: "unavailable" };
    return spec.availability(context);
  }

  run(id: ActionId, context: ActionContext): boolean {
    if (this.availability(id, context).state !== "available") return false;
    this.#handlers[id]?.(context);
    return true;
  }

  title(id: ActionId): string {
    return findSpec(id).title;
  }

  bindingLabel(id: ActionId): string | undefined {
    return findSpec(id).binding?.label[this.#platform];
  }

  handleKeydown(event: KeyboardEvent, context: ActionContext): boolean {
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
  id: ActionId,
  title: string,
  availability: ActionSpec["availability"],
  binding?: Binding,
): ActionSpec {
  return binding === undefined
    ? { id, title, availability }
    : { id, title, availability, binding };
}

function mod(keyValue: string, macos: string, other: string): Binding {
  return {
    key: keyValue,
    mod: true,
    scope: "global",
    input: "nonText",
    label: { macos, other },
  };
}

function altKey(
  keyValue: string,
  macos: string,
  other: string,
  scope: ActionScope,
): Binding {
  return {
    key: keyValue,
    alt: true,
    scope,
    input: "never",
    label: { macos, other },
  };
}

function key(keyValue: string, label: string, scope: ActionScope): Binding {
  return {
    key: keyValue,
    scope,
    input: "never",
    label: { macos: label, other: label },
  };
}

function findSpec(id: ActionId): ActionSpec {
  const spec = specs.find((candidate) => candidate.id === id);
  if (spec === undefined) throw new Error(`unknown command: ${id}`);
  return spec;
}

function activeScopes(target: EventTarget | null): readonly ActionScope[] {
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
    inputPolicyAllows(event.target, binding.input)
  );
}

function inputPolicyAllows(
  target: EventTarget | null,
  policy: Binding["input"],
): boolean {
  if (policy === "always" || !(target instanceof Element)) return true;
  const editable = target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
  );
  if (editable === null) return true;
  if (policy === "never") return false;
  if (policy === "nonText") return true;
  return editable instanceof HTMLInputElement && editable.value.length === 0;
}
