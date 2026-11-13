# E2E isolation and settling

Status: experiment on the `e2e-isolation` branch; measured before it goes near main.

## Problem

Main CI failed 14 of its last 40 runs, almost always on a different, rarely failing Playwright
test. Two causes dominate:

- **Shared server state.** Every Ergo-backed spec logs the app into the same `weblounge` account
  and autojoins the same `#weblounge-test`. One test's traffic reaches another test's page: idle
  frames during `nativeFeelAudit`, long leftover histories, read markers, MONITOR, kicks and push
  subscriptions on the shared account. The socket forwarder's controls (`/drop`, `/inject`,
  `/pause-incoming`, …) act on every connection, so a resilience test cuts every other test's
  socket too. That is why Ergo runs are pinned to one worker.
- **Asserting mid-transition.** Tests assert while the app is still moving: phone push/pop motion,
  the chats list's scroll restore after a pop, a catch-up still in progress, an older-history page
  in flight. Each spec grew its own ad-hoc wait for the one it tripped on.

## Approach

### 1. One account, one channel, one forwarder scope per test

A Playwright fixture, `irc`, gives each test that asks for it a fresh account registered through
Ergo's HTTP API (`/v1/saregister`, already enabled in the local Ergo and already used by
`IrcClient.connectIsolated`). No Ergo config change and no pre-seeded accounts: registration is
one local HTTP call.

Names are `<label>-<id>` where `id` is the worker's parallel index plus a random base36 tail, kept
under Ergo's 32-byte nick limit. The app account's nickname equals its account.

The app autojoins a build-time default channel (`#weblounge-test`). The debug harness gains one
URL parameter, `irc-channel`, which replaces that default for the session, the same way
`irc-account` and `irc-nickname` already replace the build-time account and nickname. The fixture
always passes it, so no isolated test touches `#weblounge-test`.

The socket forwarder learns which test owns each connection from a cookie,
`weblounge-e2e-scope=<account>`, that the fixture sets on the test's browser context. The browser
sends it with the WebSocket upgrade (pages and workers alike), the preview proxy passes it on, and
the forwarder reads it from the upgrade request before forwarding anything. Every control accepts
`?scope=<account>` and then acts only on that test's connections, including ones opened later
(a scoped `/drop` refuses that scope's new sockets exactly as the global one refuses all). The app
is unchanged by this. IRC peers connect straight to Ergo and never pass the forwarder.

Two tests restart Ergo itself (`startup` handshake-pending, `connection-resilience` restarts).
They are tagged `@ergo-restart` and run in their own single-worker pass after the parallel pass.

### 2. One settled helper

`expectSettled(page, { conversation? })` polls one `page.evaluate` snapshot until nothing
user-visible is still in flight, and its failure message lists what was not:

| Still in flight | Existing signal |
|---|---|
| phone push/pop or back-swipe motion | `[data-motion]` on a mobile screen |
| member drawer opening/closing/following | `[data-moving="true"]` on the overlay |
| catch-up sweep or logo fill (title, sidebar, chats header) | `[data-connection-progress]` |
| older-history page loading | `[data-divider-kind="loading"]` |
| keyboard geometry settling | `#root[data-keyboard-watch]` |
| chats list restoring its scroll after a pop | **new** `[data-restoring-scroll]` on the chats list |
| expected conversation shown (optional) | its heading is visible |

The only new attribute mirrors state the chats list already keeps (`restoringScroll`, set for
two frames after a pop); it becomes a signal so the attribute is a true reflection of it, not a
test hook. Tests replace their own `[data-motion]`/`aria-busy` waits with the helper.

### Fixture API

```ts
import { expect, test } from "./irc-fixture";

test("…", async ({ page, irc }) => {
  const peer = await irc.peer("ana");            // registered, joined to irc.channel, auto-closed
  const other = irc.channelNamed("other");       // unique extra channel name
  await page.goto(irc.url({ autojoin: [other] }));
  await expectSettled(page, { conversation: irc.channel });
  await irc.forwarder.drop();                     // this test's sockets only
});
```

`irc` exposes `account` (= nickname), `password`, `channel`, `url()`, `channelNamed()`,
`peer(label, channels?)`, `self()` (a side connection as the app's own account), `scope(context)`
for extra browser contexts, and `forwarder` (`drop`, `restore`, `pauseIncoming`,
`resumeIncoming`, `inject`, `dropIncomingContaining`). The duplicated per-spec helpers
(`accountUrl`, `isolatedStartUrl`, `controlForwarder`, `serverTime`, `messageId`) fold into it or
into `irc-client.ts`.

## Migration plan

1. Design doc (this).
2. `irc-channel` debug parameter with unit tests.
3. Forwarder scoping with its node tests.
4. Fixture and settled helper, proven on one spec.
5. Recently flaky specs first, one or two per commit: stale-snapshot, spacing-audit,
   mobile-read-state, close-phone, typing, new-divider-focused, buffer-order, close-conversation,
   native-feel, desktop-shell, channel-part, push-notifications, launch-catchup,
   timeline-jump-count.
6. The remaining Ergo specs.
7. Tag the restart tests, then run Ergo shards with two workers in CI.

A spec that fails more often once isolated exposes a real bug; it is reported, not papered over.
No assertion is weakened and no retry, sleep or timeout is added.

## Out of scope

Production-profile specs (`production-*.spec.ts`, manual lane), the push VM test
(`nix/push-e2e.nix`), and individual flakes whose cause is neither shared state nor an unsettled
transition.

## Measurement

- Local: the migrated specs with `--repeat-each=3` at `--workers=2` (and 4 when the host allows),
  on main and on the branch, same command and built app per side; count failed tests per run.
- CI: up to five sequential `workflow_dispatch` runs of the branch, compared with main's recent
  pass rate (`gh run list -b main -w CI`), plus the e2e shard durations at two workers.
