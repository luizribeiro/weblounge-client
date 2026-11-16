import type { CommandSpec } from "../../engine/protocol";

export const fileCommand: CommandSpec = {
  name: "file",
  aliases: [],
  arguments: [],
  usage: "cmd.file.usage",
  description: "cmd.file.description",
  requirements: [],
  permission: "anyone",
  surfaces: ["slash"],
  confirm: "none",
  secret_arguments: false,
};
