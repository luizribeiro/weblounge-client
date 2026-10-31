import type { CommandPermission } from "../engine/generated/CommandPermission";
import type { CommandSpec, CompletionResult } from "../engine/protocol";
import { t } from "../features/composer/strings";

export type UiActionId =
  | "buffer.next"
  | "buffer.open"
  | "buffer.open-direct"
  | "buffer.previous"
  | "debug.viewport"
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
export type EngineActionId = `command.${string}`;
export type ActionId = UiActionId | EngineActionId;

export type ActionScope = "global" | "desktop" | "list";
export type Platform = "macos" | "other";

export interface ActionContext {
  readonly bufferCount: number;
  readonly connected?: boolean;
  readonly debugViewport?: boolean;
  readonly features?: readonly string[];
  readonly listActive: boolean;
  readonly permission?: CommandPermission;
  readonly targetBufferId?: number;
  readonly targetNetworkId?: number;
  readonly targetNick?: string;
}

export interface ActionAvailability {
  readonly state: "available" | "unavailable";
}

export type ActionHandler = (context: ActionContext) => void;
export type CommandSource = "typed" | "menu";
export type ActionRunResult = "ran" | "unavailable" | "confirmation_required";
export type EngineActionHandler = (
  command: CommandSpec,
  context: ActionContext,
) => void;

export interface ActionEntry {
  readonly id: ActionId;
  readonly title: string;
  readonly command?: CommandSpec;
}

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
  readonly id: UiActionId;
  readonly title: string;
  readonly availability: (context: ActionContext) => ActionAvailability;
  readonly binding?: Binding;
  readonly discoverable?: boolean;
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
  {
    ...command("debug.viewport", "Viewport diagnostics", alwaysAvailable),
    discoverable: false,
  },
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
  command("buffer.open-direct", "Open direct message", alwaysAvailable),
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

export function isActionId(id: string): id is ActionId {
  return id.startsWith("command.") || specs.some((spec) => spec.id === id);
}

export class ActionRegistry {
  readonly #handlers: Readonly<Partial<Record<UiActionId, ActionHandler>>>;
  readonly #platform: Platform;
  readonly #engineHandler: EngineActionHandler | undefined;
  #commands: readonly CommandSpec[];

  constructor(
    handlers: Readonly<Partial<Record<UiActionId, ActionHandler>>>,
    platform: Platform,
    commands: readonly CommandSpec[] = [],
    engineHandler?: EngineActionHandler,
  ) {
    this.#handlers = handlers;
    this.#platform = platform;
    this.#commands = commands;
    this.#engineHandler = engineHandler;
  }

  availability(id: ActionId, context: ActionContext): ActionAvailability {
    if (id.startsWith("command.")) {
      const command = this.#command(id);
      return command !== undefined &&
        this.#engineHandler !== undefined &&
        allowed(command, context)
        ? { state: "available" }
        : { state: "unavailable" };
    }
    const uiId = id as UiActionId;
    const spec = findSpec(uiId);
    if (this.#handlers[uiId] === undefined) return { state: "unavailable" };
    return spec.availability(context);
  }

  run(
    id: ActionId,
    context: ActionContext,
    source: CommandSource = "menu",
    confirmed = false,
  ): ActionRunResult {
    if (this.availability(id, context).state !== "available")
      return "unavailable";
    if (id.startsWith("command.")) {
      const command = this.#command(id);
      if (command === undefined) return "unavailable";
      if (!confirmed && needsConfirmation(command, source))
        return "confirmation_required";
      this.#engineHandler?.(command, context);
      return "ran";
    }
    this.#handlers[id as UiActionId]?.(context);
    return "ran";
  }

  title(id: UiActionId): string {
    return findSpec(id).title;
  }

  bindingLabel(id: UiActionId): string | undefined {
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
    return this.run(spec.id, context) === "ran";
  }

  updateCommands(commands: readonly CommandSpec[]): void {
    this.#commands = commands;
  }

  palette(context: ActionContext): readonly ActionEntry[] {
    return this.#entries(context, "palette");
  }

  help(context: ActionContext): readonly ActionEntry[] {
    return this.#entries(context, "help");
  }

  runInput(input: string, context: ActionContext): ActionRunResult | undefined {
    const match = input.trim().match(/^\/debug(?:\s+(\S+))?(?:\s.*)?$/iu);
    if (match === null) return undefined;
    const mode = match[1]?.toLocaleLowerCase();
    return this.run("debug.viewport", {
      ...context,
      ...(mode === "viewport" || mode === "off"
        ? { debugViewport: mode === "viewport" }
        : {}),
    });
  }

  completeInput(
    commandId: string,
    bufferId: number,
    input: string,
    cursor: number,
  ): CompletionResult | undefined {
    if (input.slice(0, cursor).trimStart().toLocaleLowerCase() !== "/debug")
      return undefined;
    return {
      type: "completion_result",
      command_id: commandId,
      buffer_id: bufferId,
      input,
      replace_start: input.indexOf("/"),
      replace_end: cursor,
      trigger: "command",
      argument_hint: null,
      replacement_prefix: "/",
      replacement_suffix: " ",
      candidates: [
        {
          type: "command",
          name: "debug",
          usage: "cmd.debug.usage",
          description: "cmd.debug.description",
        },
      ],
    };
  }

  #entries(
    context: ActionContext,
    surface: "palette" | "help",
  ): readonly ActionEntry[] {
    const ui = specs
      .filter(
        (spec) =>
          spec.discoverable !== false &&
          this.#handlers[spec.id] !== undefined &&
          spec.availability(context).state === "available",
      )
      .map(({ id, title }) => ({ id, title }));
    const commands = this.#commands
      .filter(
        (command) =>
          allowed(command, context) &&
          (surface === "help" || command.surfaces.includes("palette")),
      )
      .map((command) => ({
        id: `command.${command.name}` as const,
        title: t(command.description),
        command,
      }));
    return [...ui, ...commands];
  }

  #command(id: ActionId): CommandSpec | undefined {
    const name = id.slice("command.".length);
    return this.#commands.find((command) => command.name === name);
  }
}

function allowed(command: CommandSpec, context: ActionContext): boolean {
  const features = context.features ?? [];
  return (
    command.requirements.every((requirement) =>
      requirement.type === "connected"
        ? context.connected === true
        : features.includes(requirement.value),
    ) &&
    permissionRank(context.permission ?? "anyone") >=
      permissionRank(command.permission)
  );
}

function permissionRank(permission: CommandPermission): number {
  switch (permission) {
    case "anyone":
      return 0;
    case "half_op":
      return 1;
    case "op":
      return 2;
    case "oper":
      return 3;
    default: {
      const exhaustive: never = permission;
      return exhaustive;
    }
  }
}

function needsConfirmation(
  command: CommandSpec,
  source: CommandSource,
): boolean {
  return (
    command.confirm === "always" ||
    (command.confirm === "menu" && source === "menu")
  );
}

function command(
  id: UiActionId,
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

function findSpec(id: UiActionId): ActionSpec {
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
