import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("badge.js", import.meta.url), "utf8");

function pageWithBadgeShim({ withInternals = true } = {}) {
  const calls = [];
  const window = withInternals
    ? {
        __TAURI_INTERNALS__: {
          invoke: async (command, args) => {
            calls.push([command, args]);
          },
        },
      }
    : {};
  const navigator = {};
  runInNewContext(script, { window, navigator });
  return { navigator, calls };
}

async function badgeValueSentFor(call) {
  const { navigator, calls } = pageWithBadgeShim();
  await call(navigator);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "plugin:window|set_badge_count");
  return calls[0][1].value;
}

test("a count is forwarded as the badge", async () => {
  assert.equal(await badgeValueSentFor((n) => n.setAppBadge(7)), 7);
});

test("no argument sets a generic badge", async () => {
  assert.equal(await badgeValueSentFor((n) => n.setAppBadge()), 1);
});

test("zero, null and clearAppBadge remove the badge", async () => {
  assert.equal(await badgeValueSentFor((n) => n.setAppBadge(0)), null);
  assert.equal(await badgeValueSentFor((n) => n.setAppBadge(null)), null);
  assert.equal(await badgeValueSentFor((n) => n.clearAppBadge()), null);
});

test("fractions are truncated", async () => {
  assert.equal(await badgeValueSentFor((n) => n.setAppBadge(3.9)), 3);
  assert.equal(await badgeValueSentFor((n) => n.setAppBadge(0.5)), null);
});

for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1e300, "many"]) {
  test(`${String(invalid)} is rejected with a TypeError and never sent`, async () => {
    const { navigator, calls } = pageWithBadgeShim();
    await assert.rejects(navigator.setAppBadge(invalid), { name: "TypeError" });
    assert.equal(calls.length, 0);
  });
}

test("without Tauri internals both calls resolve", async () => {
  const { navigator } = pageWithBadgeShim({ withInternals: false });
  await navigator.setAppBadge(4);
  await navigator.clearAppBadge();
});
