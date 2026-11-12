import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("notification.js", import.meta.url), "utf8");

function pageWithNotificationShim({
  initialPermission,
  withInternals = true,
  results = {},
  gates = {},
} = {}) {
  const calls = [];
  const page = {};
  page.window = page;
  if (initialPermission !== undefined) {
    page.__weblounge_initial_permission = initialPermission;
  }
  if (withInternals) {
    page.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        calls.push(JSON.parse(JSON.stringify([command, args ?? null])));
        await gates[command];
        const result = results[command];
        if (result instanceof Error) {
          throw result;
        }
        return result;
      },
    };
  }
  runInNewContext(script, page);
  return { page, calls };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the permission starts from the native state", () => {
  assert.equal(pageWithNotificationShim().page.Notification.permission, "default");
  for (const initialPermission of ["default", "denied", "granted"]) {
    const { page } = pageWithNotificationShim({ initialPermission });
    assert.equal(page.Notification.permission, initialPermission);
  }
  const { page } = pageWithNotificationShim({ initialPermission: "bogus" });
  assert.equal(page.Notification.permission, "default");
});

test("the page can detect the Notification API", () => {
  const { page } = pageWithNotificationShim();
  assert.equal(runInNewContext('"Notification" in window', page), true);
});

test("requestPermission resolves to and records the native answer", async () => {
  const { page, calls } = pageWithNotificationShim({
    results: { request_notification_permission: "granted" },
  });
  assert.equal(await page.Notification.requestPermission(), "granted");
  assert.equal(page.Notification.permission, "granted");
  assert.deepEqual(calls, [["request_notification_permission", null]]);
});

test("requestPermission keeps the current permission when native fails", async () => {
  const { page } = pageWithNotificationShim({
    initialPermission: "denied",
    results: { request_notification_permission: new Error("not allowed") },
  });
  assert.equal(await page.Notification.requestPermission(), "denied");
  assert.equal(page.Notification.permission, "denied");
});

test("requestPermission ignores an unknown native answer", async () => {
  const { page } = pageWithNotificationShim({
    results: { request_notification_permission: "maybe" },
  });
  assert.equal(await page.Notification.requestPermission(), "default");
});

test("a tagged notification posts under its tag", async () => {
  const { page, calls } = pageWithNotificationShim();
  new page.Notification("#rust", { body: "luiz: hello", tag: "libera/#rust" });
  await settle();
  assert.deepEqual(calls, [
    [
      "post_notification",
      { id: "libera/#rust", title: "#rust", body: "luiz: hello" },
    ],
  ]);
});

test("untagged notifications get distinct generated ids", async () => {
  const { page, calls } = pageWithNotificationShim();
  new page.Notification("one");
  new page.Notification("two", { body: "b" });
  await settle();
  const [first, second] = calls.map(([, args]) => args);
  assert.notEqual(first.id, second.id);
  assert.equal(first.body, null);
  assert.equal(second.body, "b");
});

test("close removes the notification natively", async () => {
  const { page, calls } = pageWithNotificationShim();
  const notification = new page.Notification("#rust", { tag: "libera/#rust" });
  notification.close();
  await settle();
  assert.deepEqual(calls.at(-1), ["close_notification", { id: "libera/#rust" }]);
});

test("closing a replaced notification leaves its successor alone", async () => {
  const { page, calls } = pageWithNotificationShim();
  const older = new page.Notification("a", { tag: "t" });
  new page.Notification("b", { tag: "t" });
  older.close();
  await settle();
  assert.deepEqual(
    calls.map(([command]) => command),
    ["post_notification", "post_notification"],
  );
});

test("a click runs the newest instance's onclick for its tag", async () => {
  const { page } = pageWithNotificationShim();
  const clicked = [];
  const older = new page.Notification("a", { tag: "t" });
  older.onclick = () => clicked.push("older");
  const newer = new page.Notification("b", { tag: "t" });
  newer.onclick = () => clicked.push("newer");
  const other = new page.Notification("c", { tag: "u" });
  other.onclick = () => clicked.push("other");
  page.__weblounge_notifications.click("t");
  assert.deepEqual(clicked, ["newer"]);
});

test("a click for an unknown id or without onclick does nothing", () => {
  const { page } = pageWithNotificationShim();
  new page.Notification("a", { tag: "t" });
  page.__weblounge_notifications.click("t");
  page.__weblounge_notifications.click("nope");
});

test("without Tauri internals everything resolves quietly", async () => {
  const { page } = pageWithNotificationShim({
    withInternals: false,
    initialPermission: "granted",
  });
  const notification = new page.Notification("a", { tag: "t" });
  notification.close();
  assert.equal(await page.Notification.requestPermission(), "granted");
  await settle();
});

test("close then a same-tag post reach native in order, the post after the close settles", async () => {
  let openCloseGate;
  const gates = {
    close_notification: new Promise((resolve) => {
      openCloseGate = resolve;
    }),
  };
  const { page, calls } = pageWithNotificationShim({ gates });
  const older = new page.Notification("a", { tag: "t" });
  await settle();
  older.close();
  new page.Notification("b", { tag: "t" });
  await settle();
  assert.deepEqual(
    calls.map(([command]) => command),
    ["post_notification", "close_notification"],
  );
  openCloseGate();
  await settle();
  assert.deepEqual(
    calls.map(([command]) => command),
    ["post_notification", "close_notification", "post_notification"],
  );
});

test("a failed close does not block later posts", async () => {
  const { page, calls } = pageWithNotificationShim({
    results: { close_notification: new Error("boom") },
  });
  new page.Notification("a", { tag: "t" }).close();
  new page.Notification("b", { tag: "u" });
  await settle();
  assert.equal(calls.at(-1)[0], "post_notification");
});

test("a pending permission prompt does not hold up posts", async () => {
  const gates = { request_notification_permission: new Promise(() => undefined) };
  const { page, calls } = pageWithNotificationShim({ gates });
  page.Notification.requestPermission();
  new page.Notification("a", { tag: "t" });
  await settle();
  assert.equal(calls.at(-1)[0], "post_notification");
});

test("overlapping permission requests share one native call", async () => {
  const { page, calls } = pageWithNotificationShim({
    results: { request_notification_permission: "granted" },
  });
  const [first, second] = await Promise.all([
    page.Notification.requestPermission(),
    page.Notification.requestPermission(),
  ]);
  assert.equal(first, "granted");
  assert.equal(second, "granted");
  assert.equal(calls.length, 1);
  await page.Notification.requestPermission();
  assert.equal(calls.length, 2);
});
