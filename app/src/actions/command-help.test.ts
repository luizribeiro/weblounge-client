import { expect, it } from "vitest";
import { commandHelp } from "./command-help";

const join: import("../engine/protocol").CommandSpec = {
  name: "join",
  aliases: ["j"],
  arguments: [],
  usage: "cmd.join.usage",
  description: "cmd.join.description",
  requirements: [],
  permission: "anyone",
  surfaces: ["slash"],
  confirm: "none",
  secret_arguments: false,
};

it("renders translated command help and unknown commands", () => {
  expect(commandHelp([join], "j")).toBe(
    "/join <channels> [keys] — Join one or more channels",
  );
  expect(commandHelp([join], "whois")).toBe("Unknown command /whois.");
  expect(commandHelp([join], null)).toBe("/join");
});
