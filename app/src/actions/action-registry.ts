import type { CommandPermission } from "../engine/generated/CommandPermission";
import type { CommandSpec, CompletionResult } from "../engine/protocol";
import { t, translate } from "../strings";

export type UiActionId =
  | "buffer.next"
  | "buffer.open"
  | "buffer.open-direct"
  | "buffer.previous"
  | "debug.overlay"
  | "list.next"
  | "list.open"
  | "list.previous"
  | "members.toggle"
  | "message.jump-bottom"
  | "network.add"
  | "network.open-server"
  | "palette.open"
  | "pane.show-buffer"
  | "settings.open"
  | "sidebar.toggle"
  | "switcher.open";
export type EngineActionId = `command.${string}`;
export type ActionId = UiActionId | EngineActionId;

export type ActionScope = "global" | "desktop" | "list";
export type Platform = "macos" | "other";
export type ActionShell = "tauri" | "web";
export type ActionGroup =
  | "Commands"
  | "Messages"
  | "Navigation"
  | "Network"
  | "View";
type ActionSurface = "help" | "palette";

export interface ActionContext {
  readonly bufferCount: number;
  readonly currentBufferKind?: "channel" | "direct" | "server";
  readonly connected?: boolean;
  readonly debugOverlay?:
    | "gestures"
    | "keyboard"
    | "off"
    | "push"
    | "summary"
    | "viewport";
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
  readonly group?: ActionGroup;
  readonly chord?: string;
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
  readonly shells?: readonly ActionShell[];
}

interface ActionSpec {
  readonly id: UiActionId;
  readonly title: string;
  readonly availability: (context: ActionContext) => ActionAvailability;
  readonly bindings?: readonly Binding[];
  readonly surfaces: readonly ActionSurface[];
  readonly group: ActionGroup;
}

const alwaysAvailable = (): ActionAvailability => ({ state: "available" });
const needsBuffers = (context: ActionContext): ActionAvailability => ({
  state: context.bufferCount > 1 ? "available" : "unavailable",
});
const needsList = (context: ActionContext): ActionAvailability => ({
  state: context.listActive ? "available" : "unavailable",
});
const needsChannel = (context: ActionContext): ActionAvailability => ({
  state: context.currentBufferKind === "channel" ? "available" : "unavailable",
});

const specs: readonly ActionSpec[] = [
  command(
    "switcher.open",
    t("action.switcher"),
    alwaysAvailable,
    mod("k", "⌘K", "Ctrl+K"),
  ),
  {
    ...command("debug.overlay", t("action.debug"), alwaysAvailable),
    surfaces: [],
  },
  {
    ...command("settings.open", t("action.settings"), alwaysAvailable),
    surfaces: [],
  },
  command("sidebar.toggle", t("action.sidebar_toggle"), alwaysAvailable, {
    ...mod("s", "⌥⌘S", "Ctrl+Alt+S"),
    alt: true,
  }),
  command(
    "members.toggle",
    t("action.members_toggle"),
    needsChannel,
    mod(".", "⌘.", "Ctrl+."),
  ),
  command("palette.open", t("action.palette"), alwaysAvailable, [
    { ...mod("p", "⇧⌘P", "Ctrl+Shift+P"), shift: true, shells: ["tauri"] },
    { ...mod(".", "⇧⌘.", "Ctrl+Shift+."), shift: true, shells: ["web"] },
  ]),
  {
    ...command("buffer.open", t("action.open_buffer"), alwaysAvailable, {
      ...mod("k", "⇧⌘K", "Ctrl+Shift+K"),
      shift: true,
    }),
    surfaces: ["help"],
  },
  {
    ...command("buffer.open-direct", t("action.open_direct"), alwaysAvailable),
    surfaces: ["help"],
  },
  {
    ...command("network.add", t("action.add_network"), alwaysAvailable),
    surfaces: [],
  },
  {
    ...command(
      "network.open-server",
      t("action.network_server"),
      alwaysAvailable,
    ),
    surfaces: ["help"],
  },
  command(
    "message.jump-bottom",
    t("action.jump_bottom"),
    alwaysAvailable,
    key("End", "End", "desktop"),
  ),
  {
    ...command("pane.show-buffer", t("action.show_buffer"), alwaysAvailable),
    surfaces: ["help"],
  },
  command(
    "buffer.previous",
    t("action.previous_buffer"),
    needsBuffers,
    altKey("ArrowUp", "⌥↑", "Alt+↑", "desktop"),
  ),
  command(
    "buffer.next",
    t("action.next_buffer"),
    needsBuffers,
    altKey("ArrowDown", "⌥↓", "Alt+↓", "desktop"),
  ),
  {
    ...command(
      "list.previous",
      t("action.list_previous"),
      needsList,
      key("ArrowUp", "↑", "list"),
    ),
    surfaces: ["help"],
  },
  {
    ...command(
      "list.next",
      t("action.list_next"),
      needsList,
      key("ArrowDown", "↓", "list"),
    ),
    surfaces: ["help"],
  },
  {
    ...command(
      "list.open",
      t("action.list_open"),
      needsList,
      key("Enter", "↵", "list"),
    ),
    surfaces: ["help"],
  },
];

export function isActionId(id: string): id is ActionId {
  return id.startsWith("command.") || specs.some((spec) => spec.id === id);
}

export class ActionRegistry {
  readonly #handlers: Readonly<Partial<Record<UiActionId, ActionHandler>>>;
  readonly #platform: Platform;
  readonly #shell: ActionShell;
  readonly #engineHandler: EngineActionHandler | undefined;
  #commands: readonly CommandSpec[];

  constructor(
    handlers: Readonly<Partial<Record<UiActionId, ActionHandler>>>,
    platform: Platform,
    commands: readonly CommandSpec[] = [],
    engineHandler?: EngineActionHandler,
    shell: ActionShell = "web",
  ) {
    this.#handlers = handlers;
    this.#platform = platform;
    this.#shell = shell;
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
    return this.#binding(findSpec(id))?.label[this.#platform];
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
    const match = specs
      .flatMap(
        (spec) => spec.bindings?.map((binding) => ({ binding, spec })) ?? [],
      )
      .find(
        ({ binding, spec }) =>
          this.#bindingApplies(binding) &&
          scopes.includes(binding.scope) &&
          matches(event, binding) &&
          this.availability(spec.id, context).state === "available",
      );
    if (match === undefined) return false;
    event.preventDefault();
    event.stopPropagation();
    return this.run(match.spec.id, context) === "ran";
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
    return this.run("debug.overlay", {
      ...context,
      ...(mode === undefined
        ? { debugOverlay: "summary" }
        : mode === "viewport" ||
            mode === "gestures" ||
            mode === "keyboard" ||
            mode === "push" ||
            mode === "off"
          ? { debugOverlay: mode }
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
          spec.surfaces.includes(surface) &&
          this.#handlers[spec.id] !== undefined &&
          spec.availability(context).state === "available",
      )
      .map((spec) => {
        const chord = this.#binding(spec)?.label[this.#platform];
        return {
          id: spec.id,
          title: spec.title,
          group: spec.group,
          ...(chord === undefined ? {} : { chord }),
        };
      });
    const commands = this.#commands
      .filter(
        (command) =>
          allowed(command, context) &&
          (surface === "help" ||
            (command.surfaces.includes("palette") &&
              canInvokeFromPalette(command, context))),
      )
      .map((command) => ({
        id: `command.${command.name}` as const,
        title: translate(command.description),
        group: "Commands" as const,
        command,
      }));
    return [...ui, ...commands];
  }

  #command(id: ActionId): CommandSpec | undefined {
    const name = id.slice("command.".length);
    return this.#commands.find((command) => command.name === name);
  }

  #binding(spec: ActionSpec): Binding | undefined {
    return spec.bindings?.find((binding) => this.#bindingApplies(binding));
  }

  #bindingApplies(binding: Binding): boolean {
    return binding.shells === undefined || binding.shells.includes(this.#shell);
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

function canInvokeFromPalette(
  command: CommandSpec,
  context: ActionContext,
): boolean {
  return (
    context.currentBufferKind !== undefined &&
    command.arguments.every(
      (argument) =>
        !argument.required &&
        (argument.kind !== "channel" ||
          context.currentBufferKind === "channel"),
    )
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
  binding?: Binding | readonly Binding[],
): ActionSpec {
  const base = {
    id,
    title,
    availability,
    group: groupFor(id),
    surfaces: ["help", "palette"] as const,
  };
  if (binding === undefined) return base;
  return { ...base, bindings: Array.isArray(binding) ? binding : [binding] };
}

function groupFor(id: UiActionId): ActionGroup {
  if (id.startsWith("network.")) return "Network";
  if (id.startsWith("message.")) return "Messages";
  if (id === "members.toggle" || id === "sidebar.toggle") return "View";
  return "Navigation";
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
