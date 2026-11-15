import assert from "node:assert/strict";
import test from "node:test";
import {
  advertisedCaps,
  capabilityRequest,
  isFinalCapList,
  requiredCaps,
} from "./irc-caps.mjs";

const pushVmList =
  ":ergo.test CAP * LS :account-notify account-tag batch draft/multiline draft/read-marker echo-message message-tags sasl=PLAIN,EXTERNAL server-time";

test("requests only offered optional caps, so a server without redaction accepts", () => {
  assert.deepEqual(capabilityRequest(advertisedCaps(pushVmList)), requiredCaps);
  assert.deepEqual(
    capabilityRequest([
      ...advertisedCaps(pushVmList),
      "draft/message-redaction",
    ]),
    [...requiredCaps, "draft/message-redaction"],
  );
});

test("names a required cap the server does not offer", () => {
  assert.throws(
    () => capabilityRequest(["sasl", "batch"]),
    /does not offer account-tag, draft\/multiline/u,
  );
});

test("reads values off cap names and tells a continued list from its last line", () => {
  const continued = ":irc.localhost CAP * LS * :sasl=PLAIN,EXTERNAL batch";
  assert.deepEqual(advertisedCaps(continued), ["sasl", "batch"]);
  assert.equal(isFinalCapList(continued), false);
  assert.equal(isFinalCapList(pushVmList), true);
});
