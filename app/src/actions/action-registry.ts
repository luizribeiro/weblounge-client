import type { CommandPermission } from "../engine/generated/CommandPermission";
import type { CommandSpec, CompletionResult } from "../engine/protocol";
import { t, translate } from "../strings";

export const jumpSlots = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type JumpSlot = (typeof jumpSlots)[number];
type JumpActionId = `buffer.jump-${JumpSlot}`;

export type UiActionId =
  | JumpActionId
  | "buffer.mark-read"
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
export type Platform = "macos" | "linux" | "other";
type LabelPlatform = "macos" | "other";
export type ActionShell = "tauri" | "web";
export type ActionGroup =
  | "Commands"
  | "Messages"
  | "Navigation"
  | "Network"
  | "View";
type ActionSurface = "channelMenu" | "help" | "palette";

export interface ActionContext {
  readonly bufferCount: number;
  readonly conversationCount?: number;
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
  readonly targetUnread?: boolean;
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
  readonly ctrl?: boolean;
  readonly mod?: boolean;
  readonly shift?: boolean;
  readonly scope: ActionScope;
  readonly input: "never" | "nonText" | "emptyComposer" | "always";
  readonly label: Readonly<Record<LabelPlatform, string>>;
  readonly platforms?: readonly Platform[];
  readonly shells?: readonly ActionShell[];
}

export interface ModifierChord {
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

interface ActionSpec {
  readonly id: UiActionId;
  readonly title: string;
  readonly menuLabel?: string;
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
const needsUnread = (context: ActionContext): ActionAvailability => ({
  state: context.targetUnread === true ? "available" : "unavailable",
});
const needsConversation =
  (slot: JumpSlot) =>
  (context: ActionContext): ActionAvailability => ({
    state:
      (context.conversationCount ?? 0) >= slot ? "available" : "unavailable",
  });
const needsChannel = (context: ActionContext): ActionAvailability => ({
  state: context.currentBufferKind === "channel" ? "available" : "unavailable",
});

const specs: readonly ActionSpec[] = [
  {
    ...command(
      "buffer.mark-read",
      t("action.mark_read.description"),
      needsUnread,
    ),
    menuLabel: t("action.mark_read"),
    surfaces: ["channelMenu"],
  },
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
  command("buffer.previous", t("action.previous_buffer"), needsBuffers, [
    altKey("ArrowUp", "⌥↑", "Alt+↑", "desktop"),
    ...browserTabBindings("previous"),
  ]),
  command("buffer.next", t("action.next_buffer"), needsBuffers, [
    altKey("ArrowDown", "⌥↓", "Alt+↓", "desktop"),
    ...browserTabBindings("next"),
  ]),
  ...jumpSlots.map((slot) => ({
    ...command(
      jumpActionId(slot),
      t("action.jump_buffer", { slot: String(slot) }),
      needsConversation(slot),
      jumpBindings(slot),
    ),
    surfaces: [],
  })),
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

export function jumpActionId(slot: JumpSlot): JumpActionId {
  return `buffer.jump-${slot}`;
}

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
      if (!confirmed && needsConfirmation(command, source, context))
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
    const binding = this.#binding(findSpec(id));
    return binding === undefined ? undefined : this.#label(binding);
  }

  matchesBinding(id: UiActionId, event: KeyboardEvent): boolean {
    return (
      !producesText(event) &&
      this.#bindings(findSpec(id)).some((binding) => matches(event, binding))
    );
  }

  modifierChord(id: UiActionId): ModifierChord | undefined {
    const binding = this.#binding(findSpec(id));
    if (binding === undefined) return undefined;
    const mod = binding.mod === true;
    return {
      alt: binding.alt === true,
      ctrl: binding.ctrl === true || (mod && this.#platform !== "macos"),
      meta: mod && this.#platform === "macos",
      shift: binding.shift === true,
    };
  }

  handleKeydown(event: KeyboardEvent, context: ActionContext): boolean {
    if (producesText(event)) return false;
    const scopes = activeScopes(event.target);
    const match = specs
      .flatMap((spec) =>
        this.#bindings(spec).map((binding) => ({ binding, spec })),
      )
      .find(
        ({ binding, spec }) =>
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

  channelMenu(context: ActionContext): readonly ActionEntry[] {
    return this.#entries(context, "channelMenu");
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
    surface: ActionSurface,
  ): readonly ActionEntry[] {
    const ui = specs
      .filter(
        (spec) =>
          spec.surfaces.includes(surface) &&
          (surface !== "channelMenu" || spec.menuLabel !== undefined) &&
          this.#handlers[spec.id] !== undefined &&
          spec.availability(context).state === "available",
      )
      .map((spec) => {
        const labels = this.#bindings(spec).map((binding) =>
          this.#label(binding),
        );
        const chord = labels.length === 0 ? undefined : labels.join(" / ");
        return {
          id: spec.id,
          title:
            surface === "channelMenu" && spec.menuLabel !== undefined
              ? spec.menuLabel
              : spec.title,
          group: spec.group,
          ...(chord === undefined ? {} : { chord }),
        };
      });
    const commands = this.#commands
      .filter(
        (command) =>
          allowed(command, context) &&
          commandApplies(command, context, surface) &&
          (surface === "help" ||
            (command.surfaces.includes(
              surface === "palette" ? "palette" : "channel_menu",
            ) &&
              (surface !== "channelMenu" || command.menu_label !== undefined) &&
              canInvokeWithoutArguments(command, context))),
      )
      .map((command) => ({
        id: `command.${command.name}` as const,
        title: translate(
          surface === "channelMenu" && command.menu_label !== undefined
            ? command.menu_label
            : command.description,
        ),
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
    return this.#bindings(spec)[0];
  }

  #bindings(spec: ActionSpec): readonly Binding[] {
    return (
      spec.bindings?.filter((binding) => this.#bindingApplies(binding)) ?? []
    );
  }

  #bindingApplies(binding: Binding): boolean {
    return (
      (binding.shells === undefined || binding.shells.includes(this.#shell)) &&
      (binding.platforms === undefined ||
        binding.platforms.includes(this.#platform))
    );
  }

  #label(binding: Binding): string {
    return binding.label[this.#platform === "macos" ? "macos" : "other"];
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

function canInvokeWithoutArguments(
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
  context: ActionContext,
): boolean {
  if (command.name === "close" && context.currentBufferKind === "direct")
    return false;
  return (
    command.confirm === "always" ||
    (command.confirm === "menu" && source === "menu")
  );
}

function commandApplies(
  command: CommandSpec,
  context: ActionContext,
  surface: ActionSurface,
): boolean {
  if (surface === "help") return true;
  if (command.name === "close") return context.currentBufferKind === "direct";
  if (command.name === "part") return context.currentBufferKind === "channel";
  return true;
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
  if (id === "buffer.mark-read") return "Messages";
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

function jumpBindings(slot: JumpSlot): readonly Binding[] {
  const digit = {
    key: String(slot),
    code: `Digit${slot}`,
    scope: "global",
    input: "always",
  } as const;
  return [
    {
      ...digit,
      mod: true,
      shells: ["tauri"],
      label: { macos: `⌘${slot}`, other: `Ctrl+${slot}` },
    },
    {
      ...digit,
      alt: true,
      platforms: ["macos", "other"],
      shells: ["web"],
      label: { macos: `⌥${slot}`, other: `Alt+${slot}` },
    },
    {
      ...digit,
      alt: true,
      mod: true,
      platforms: ["linux"],
      shells: ["web"],
      label: { macos: `⌃⌥${slot}`, other: `Ctrl+Alt+${slot}` },
    },
  ];
}

// Browsers own these tab chords and never reliably deliver them to a page, so only native shells bind them.
function browserTabBindings(
  direction: "next" | "previous",
): readonly Binding[] {
  const previous = direction === "previous";
  const bracket = previous ? "[" : "]";
  const native = {
    scope: "global",
    input: "always",
    shells: ["tauri"],
  } as const;
  return [
    {
      ...native,
      key: "Tab",
      ctrl: true,
      shift: previous,
      label: previous
        ? { macos: "⌃⇧Tab", other: "Ctrl+Shift+Tab" }
        : { macos: "⌃Tab", other: "Ctrl+Tab" },
    },
    {
      ...native,
      key: bracket,
      code: previous ? "BracketLeft" : "BracketRight",
      mod: true,
      shift: true,
      platforms: ["macos"],
      label: { macos: `⇧⌘${bracket}`, other: `Ctrl+Shift+${bracket}` },
    },
  ];
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

function producesText(event: KeyboardEvent): boolean {
  return (
    event.isComposing ||
    event.getModifierState("AltGraph") ||
    event.key === "Dead" ||
    event.key === "Process"
  );
}

function matches(event: KeyboardEvent, binding: Binding): boolean {
  return (
    commandModifiersMatch(event, binding) &&
    event.altKey === (binding.alt ?? false) &&
    event.shiftKey === (binding.shift ?? false) &&
    (binding.code === undefined
      ? event.key.toLocaleLowerCase() === binding.key.toLocaleLowerCase()
      : event.code === binding.code) &&
    inputPolicyAllows(event.target, binding.input)
  );
}

function commandModifiersMatch(
  event: KeyboardEvent,
  binding: Binding,
): boolean {
  if (binding.ctrl === true) return event.ctrlKey && !event.metaKey;
  return binding.mod === true
    ? event.metaKey || event.ctrlKey
    : !event.metaKey && !event.ctrlKey;
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
