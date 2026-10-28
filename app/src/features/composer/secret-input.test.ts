import { expect, it } from "vitest";
import type { CommandSpec } from "../../engine/protocol";
import { isSecretInput } from "./secret-input";

const identify: CommandSpec = {
  name: "identify",
  aliases: ["id"],
  arguments: [],
  usage: "cmd.identify.usage",
  description: "cmd.identify.description",
  requirements: [{ type: "connected" }],
  permission: "anyone",
  surfaces: ["slash"],
  confirm: "none",
  secret_arguments: true,
};

it("recognizes secret command names and aliases without hiding literal text", () => {
  expect(isSecretInput("/identify hunter2", [identify])).toBe(true);
  expect(isSecretInput("/ID hunter2", [identify])).toBe(true);
  expect(isSecretInput("//identify hunter2", [identify])).toBe(false);
  expect(isSecretInput("/say hunter2", [identify])).toBe(false);
});
