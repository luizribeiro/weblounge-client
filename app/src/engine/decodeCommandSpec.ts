import type { CommandArgumentKind } from "./generated/CommandArgumentKind";
import type { CommandPermission } from "./generated/CommandPermission";
import type { CommandSpec } from "./generated/CommandSpec";
import type { CommandSurface } from "./generated/CommandSurface";
import type { ConfirmPolicy } from "./generated/ConfirmPolicy";

const argumentKinds = enumValues<CommandArgumentKind>({
  nick: true,
  channel: true,
  channel_list: true,
  key_list: true,
  target: true,
  text: true,
  command_name: true,
});
const permissions = enumValues<CommandPermission>({
  anyone: true,
  half_op: true,
  op: true,
  oper: true,
});
const surfaces = enumValues<CommandSurface>({
  slash: true,
  palette: true,
  user_menu: true,
  message_menu: true,
  channel_menu: true,
  network_menu: true,
});
const confirmPolicies = enumValues<ConfirmPolicy>({
  none: true,
  menu: true,
  always: true,
});

export function decodeCommandSpecs(value: unknown): CommandSpec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const decoded = value.map(decodeCommandSpec);
  return decoded.every((spec) => spec !== undefined)
    ? decoded.filter((spec) => spec !== undefined)
    : undefined;
}

function decodeCommandSpec(value: unknown): CommandSpec | undefined {
  if (!isRecord(value)) return undefined;
  const aliases = strings(value.aliases);
  const arguments_ = Array.isArray(value.arguments)
    ? value.arguments.map(decodeArgument)
    : undefined;
  const requirements = Array.isArray(value.requirements)
    ? value.requirements.map(decodeRequirement)
    : undefined;
  const decodedSurfaces = enumArray(value.surfaces, surfaces);
  if (
    typeof value.name !== "string" ||
    aliases === undefined ||
    arguments_ === undefined ||
    arguments_.some((argument) => argument === undefined) ||
    typeof value.usage !== "string" ||
    typeof value.description !== "string" ||
    requirements === undefined ||
    requirements.some((requirement) => requirement === undefined) ||
    !isOneOf(value.permission, permissions) ||
    decodedSurfaces === undefined ||
    !isOneOf(value.confirm, confirmPolicies) ||
    !isOptionalString(value.confirmation_prompt) ||
    !isOptionalString(value.confirmation_action) ||
    typeof value.secret_arguments !== "boolean"
  )
    return undefined;
  return {
    name: value.name,
    aliases,
    arguments: arguments_.filter((argument) => argument !== undefined),
    usage: value.usage,
    description: value.description,
    requirements: requirements.filter(
      (requirement) => requirement !== undefined,
    ),
    permission: value.permission,
    surfaces: decodedSurfaces,
    confirm: value.confirm,
    ...(value.confirmation_prompt === undefined
      ? {}
      : { confirmation_prompt: value.confirmation_prompt }),
    ...(value.confirmation_action === undefined
      ? {}
      : { confirmation_action: value.confirmation_action }),
    secret_arguments: value.secret_arguments,
  };
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function decodeArgument(
  value: unknown,
): CommandSpec["arguments"][number] | undefined {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !isOneOf(value.kind, argumentKinds) ||
    typeof value.required !== "boolean"
  )
    return undefined;
  return { name: value.name, kind: value.kind, required: value.required };
}

function decodeRequirement(
  value: unknown,
): CommandSpec["requirements"][number] | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "connected") return { type: "connected" };
  if (value.type === "feature" && typeof value.value === "string")
    return { type: "feature", value: value.value };
  return undefined;
}

function enumArray<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number][] | undefined {
  return Array.isArray(value) && value.every((item) => isOneOf(item, values))
    ? value
    : undefined;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === "string" && values.some((item) => item === value);
}

function enumValues<Value extends string>(
  values: Readonly<Record<Value, true>>,
): readonly Value[] {
  return Object.keys(values) as Value[];
}
