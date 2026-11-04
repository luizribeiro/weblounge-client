import { expect, it, vi } from "vitest";
import {
  PushParserLoader,
  type PushPayloadParser,
} from "./platform/push/push-parser-loader";

it("retries loading the push parser after a cached failure", async () => {
  const parser: PushPayloadParser = {
    parse_push_payload_json: (line) => JSON.stringify({ type: line }),
  };
  const load = vi
    .fn<() => Promise<PushPayloadParser>>()
    .mockRejectedValueOnce(new Error("parser cache is unavailable"))
    .mockResolvedValue(parser);
  const loader = new PushParserLoader(load);

  await expect(loader.parse("first")).rejects.toThrow(
    "parser cache is unavailable",
  );
  await expect(loader.parse("second")).resolves.toBe(
    JSON.stringify({ type: "second" }),
  );
  expect(load).toHaveBeenCalledTimes(2);
});
