import type { CommandSpec } from "../../engine/protocol";

export function isSecretInput(
  input: string,
  commands: readonly CommandSpec[],
): boolean {
  const slash = input.startsWith("/") && !input.startsWith("//");
  if (!slash) return false;
  const name = input.slice(1).split(/\s/, 1)[0]?.toLocaleLowerCase();
  if (name === undefined || name === "") return false;
  return commands.some(
    (command) =>
      command.secret_arguments &&
      (command.name.toLocaleLowerCase() === name ||
        command.aliases.some((alias) => alias.toLocaleLowerCase() === name)),
  );
}
