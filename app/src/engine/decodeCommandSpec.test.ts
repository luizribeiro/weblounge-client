import { expect, it } from "vitest";
import { decodeCommandSpecs } from "./decodeCommandSpec";

const spec = {
  name: "fixture",
  aliases: [],
  arguments: [{ name: "text", kind: "text", required: true }],
  usage: "cmd.fixture.usage",
  description: "cmd.fixture.description",
  requirements: [{ type: "connected" }],
  permission: "anyone",
  surfaces: ["slash"],
  confirm: "none",
  secret_arguments: false,
};

it("accepts generated enum values and rejects unknown variants", () => {
  expect(decodeCommandSpecs([spec])).toHaveLength(1);
  expect(decodeCommandSpecs([{ ...spec, permission: "founder" }])).toBe(
    undefined,
  );
  expect(decodeCommandSpecs([{ ...spec, confirm: "sometimes" }])).toBe(
    undefined,
  );
});
