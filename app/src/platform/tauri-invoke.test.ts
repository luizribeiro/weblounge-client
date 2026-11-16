import { describe, expect, it } from "vitest";
import { tauriInvoke } from "./tauri-invoke";

describe("tauri invoke", () => {
  it("is absent outside a Tauri web view", () => {
    for (const internals of [undefined, null, {}, { invoke: "invoke" }]) {
      expect(tauriInvoke({ __TAURI_INTERNALS__: internals })).toBeUndefined();
    }
  });

  it("calls the shell's invoke with the command and its arguments", async () => {
    const internals = {
      calls: [] as unknown[],
      invoke(this: { calls: unknown[] }, command: string, args: unknown) {
        this.calls.push([command, args]);
        return Promise.resolve({ count: 3 });
      },
    };
    const invoke = tauriInvoke({ __TAURI_INTERNALS__: internals });

    await expect(
      invoke?.("set_badge", { request: { count: 3 } }),
    ).resolves.toEqual({ count: 3 });
    expect(internals.calls).toEqual([["set_badge", { request: { count: 3 } }]]);
  });

  it.each([
    ["rejects", () => Promise.reject(new Error("no such command"))],
    [
      "throws",
      () => {
        throw new Error("no such command");
      },
    ],
  ])(
    "fails with a rejection when the shell's invoke %s",
    async (_case, call) => {
      const invoke = tauriInvoke({ __TAURI_INTERNALS__: { invoke: call } });

      await expect(invoke?.("push_target")).rejects.toThrow("no such command");
    },
  );
});
