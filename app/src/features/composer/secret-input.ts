import type { CommandSpec } from "../../engine/protocol";

export function isSecretInput(
  input: string,
  commands: readonly CommandSpec[],
): boolean {
  const normalized = input.trimStart();
  const slash = normalized.startsWith("/") && !normalized.startsWith("//");
  if (!slash) return false;
  const name = normalized
    .slice(1)
    .trimStart()
    .split(/\s/, 1)[0]
    ?.toLocaleLowerCase();
  if (name === undefined || name === "") return false;
  return commands.some(
    (command) =>
      command.secret_arguments &&
      (command.name.toLocaleLowerCase() === name ||
        command.aliases.some((alias) => alias.toLocaleLowerCase() === name)),
  );
}
