import type { CommandSpec } from "../engine/protocol";
import { t, translate } from "../strings";

export function commandHelp(
  commands: readonly CommandSpec[],
  requested: string | null,
): string {
  if (requested === null) {
    return commands.map(({ name }) => `/${name}`).join(", ");
  }
  const command = commands.find(
    ({ name, aliases }) => name === requested || aliases.includes(requested),
  );
  return command === undefined
    ? t("composer.unknown_command", { input: `/${requested}` })
    : `${translate(command.usage)} — ${translate(command.description)}`;
}
