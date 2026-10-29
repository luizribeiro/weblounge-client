import type { CommandSpec } from "../../engine/protocol";
import { commandForInput } from "./command-input";

export function isSecretInput(
  input: string,
  commands: readonly CommandSpec[],
): boolean {
  return commandForInput(input, commands)?.secret_arguments === true;
}
