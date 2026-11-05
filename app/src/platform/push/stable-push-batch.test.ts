import { expect, it, vi } from "vitest";
import { deliverStablePushBatch } from "../../../e2e/stable-push-batch";

it("encrypts every queued push before delivery can rotate its route", async () => {
  let route = "first-route";
  const encrypt = vi.fn(async (plaintexts: readonly string[]) =>
    plaintexts.map((plaintext) => `${route}:${plaintext}`),
  );
  const delivered: string[] = [];

  await deliverStablePushBatch(
    ["first", "second"],
    encrypt,
    async (envelope) => {
      delivered.push(envelope);
      route = "rotated-route";
    },
  );

  expect(encrypt).toHaveBeenCalledExactlyOnceWith(["first", "second"]);
  expect(delivered).toEqual(["first-route:first", "first-route:second"]);
});
