import type { CommandSpec } from "../../engine/protocol";

export function commandForInput(
  input: string,
  commands: readonly CommandSpec[],
): CommandSpec | undefined {
  const normalized = input.trimStart();
  if (!normalized.startsWith("/") || normalized.startsWith("//")) return;
  const name = normalized.slice(1).trimStart().split(/\s/, 1)[0]?.toLowerCase();
  if (name === undefined || name === "") return;
  return commands.find(
    (command) =>
      command.name.toLowerCase() === name ||
      command.aliases.some((alias) => alias.toLowerCase() === name),
  );
}

/** The command when the input is the command alone, such as `/file`. */
export function bareCommandForInput(
  input: string,
  commands: readonly CommandSpec[],
): CommandSpec | undefined {
  return /^\/\s*\S+$/u.test(input.trim())
    ? commandForInput(input, commands)
    : undefined;
}
