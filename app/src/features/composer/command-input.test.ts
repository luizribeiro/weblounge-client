import { expect, it } from "vitest";
import { bareCommandForInput } from "./command-input";
import { fileCommand } from "./test-commands";

const commands = [fileCommand];

it("finds a command typed alone, in any case and spacing", () => {
  expect(bareCommandForInput("/file", commands)?.name).toBe("file");
  expect(bareCommandForInput("  /FILE  ", commands)?.name).toBe("file");
  expect(bareCommandForInput("/ file", commands)?.name).toBe("file");
});

it("ignores the command with arguments, literal text and unknown commands", () => {
  expect(bareCommandForInput("/file holiday.png", commands)).toBeUndefined();
  expect(bareCommandForInput("//file", commands)).toBeUndefined();
  expect(bareCommandForInput("file", commands)).toBeUndefined();
  expect(bareCommandForInput("/files", commands)).toBeUndefined();
});
