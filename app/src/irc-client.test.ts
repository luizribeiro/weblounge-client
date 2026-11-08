import { describe, expect, it } from "vitest";
import { claimNickname } from "../e2e/irc-nick-claim";

describe("IRC test client nickname claims", () => {
  it("retries only after the conflicting holder departs", async () => {
    const lines = [
      ":ergo.test 433 always-on-control weblounge :Nickname is already in use",
      ":weblounge!~u@example.test QUIT :connection closed",
      ":always-on-control!~u@example.test NICK :weblounge",
    ];
    const events: string[] = [];

    await claimNickname(
      "always-on-control",
      "weblounge",
      (line) => events.push(`send ${line}`),
      async (description, predicate) => {
        const line = lines.shift();
        if (line === undefined || !predicate(line)) {
          throw new Error(`Unexpected line while waiting for ${description}`);
        }
        events.push(`receive ${line}`);
        return line;
      },
    );

    expect(events).toEqual([
      "send NICK weblounge",
      "receive :ergo.test 433 always-on-control weblounge :Nickname is already in use",
      "receive :weblounge!~u@example.test QUIT :connection closed",
      "send NICK weblounge",
      "receive :always-on-control!~u@example.test NICK :weblounge",
    ]);
  });
});
