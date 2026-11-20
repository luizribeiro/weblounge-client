# 40 — DM presence: three states

Status: decisions by Luiz (feedback #45, 2026-11-20, and the papo 0.1 presence decisions); B46
and F53 in `docs/PLAN.md`.

## Problem

Luiz: "iris is always shown as away (offline?) in my DMs. … offline users should be displayed with
the empty circle, away users with the filled circle and online users with the filled/active/coloured
circle. For bots … away and offline [can be] the same icon."

The engine already watches every shown DM peer with `MONITOR`: papo's direct handle holds a lease
for an open DM, `monitor_shown_direct_peers` adds the shown DMs after launch reconciliation (half
the server's `MONITOR` limit), and closing a DM removes its peer. What was wrong is the mapping and
the look:

- `PeerPresence` had only `online` and `away`. A `731` (offline) and a `730` whose away state was
  never reported both became "no presence".
- A `730` never carries an away state. Ergo 2.19 answers `MONITOR +` for a connected peer with a
  bare `730`, and with `extended-monitor` reports only later `AWAY` changes. So a peer who shares no
  channel and hasn't spoken stayed "unknown" forever.
- The UI drew `away` as an empty muted ring, which reads as offline, and an unknown bot as a plain
  robot, which reads as away.

## Engine: `PeerPresence = online | away | offline`, absent = unknown

`PeerEvidence::presence` decides, in this order:

1. The peer shares a channel: its reported away state (channel `WHO`, `away-notify`). Unreported
   stays unknown until the channel `WHO` answers, as before.
2. `MONITOR` reported it offline (`731`, kept until a `730` or reconnect): `offline`.
3. `MONITOR` reports it online: its reported away state; a line it sent us counts as present.
   Otherwise, Luiz's rule: **unreported away state renders `away`** when the server will tell us
   when it changes (`extended-monitor` and `away-notify` both negotiated). On a server without
   them we can never learn it, so it renders `online`.
4. Otherwise: unknown (no `MONITOR`, list full, not yet answered, disconnected).

No `WHO` is sent to learn a DM peer's away state (Luiz: snapshots go stale).

Consequence to note: on Ergo, a present peer who shares no channel and hasn't messaged us since we
connected renders `away` until it sets or clears away or sends us a line. Iris is such a peer, so
B46's symptom stays for it under this rule; see "Open" below.

## Look

One `PresenceMark` component (`app/src/ui/`) draws the mark wherever presence shows. Tokens only:

| State   | Person                                                    | Bot (robot icon)            |
|---------|-----------------------------------------------------------|-----------------------------|
| online  | filled dot, `--wl-color-online` fill and ring              | robot in `--wl-color-online` |
| away    | filled dot, `--wl-color-panel-muted` fill and ring         | robot in `--wl-color-panel-muted`, 0.5 opacity |
| offline | empty ring in `--wl-color-panel-muted`                     | same as away                |
| unknown | no dot                                                    | robot in the row's text colour |

Shape separates offline from the rest without colour. Online and away are both filled, as Luiz
asked, and differ by colour; the row's accessible name says the state ("ana, online").

Where it shows:

- desktop sidebar DM rows, the phone drawer and the switcher (`BufferPrefix`), as before;
- the phone chat list: the mark on the DM avatar's bottom-right corner (a bot's robot too), on a
  `--wl-color-surface` disc to separate it from the avatar; the row's label is unchanged;
- the DM header, desktop and phone: the mark and "Direct message · online" (away, offline) as the
  subtitle, like the prototype's "direct message · online"; unknown keeps today's header (nothing
  on desktop, "Direct message" on the phone).

The member list is unchanged: everyone in it shares the channel, so nobody is offline, and the
prototype groups Online and Away with away rows muted.

Contrast (marks are non-text UI, so 3:1 against the panel and the selected row): every theme
passes except `modern`'s existing online green on the selected row (2.8:1). Online against away is
a hue difference only, weakest in `lounge` (1.1:1 luminance, green against grey) and `n.e.` is
yellow against grey (1.7:1).

## Out of scope

- Seeding the away state of a newly watched peer (see "Open").
- Presence for channel members beyond the existing Online/Away grouping.
- `MONITOR` beyond the server's limit: the overflow stays unknown, with the existing
  "Presence updates are unavailable" notice.

## Testing

- Engine (`direct_peer.rs`, `runtime.rs`): `731` → offline; `730` unreported → away with
  `extended-monitor`, online without; reported away and a peer's own line win; reconnect clears.
- Playwright against the local Ergo (`sidebar-presence.spec.ts`, `dm-presence.spec.ts`): a DM with
  a peer sharing no channel goes online (it messaged us), away on `AWAY`, offline when it quits, on
  desktop and phone, with icon-state assertions; screenshots of the three states in light and dark.

## Open (Luiz)

The away-until-reported rule makes a present, quiet, no-shared-channel peer look away on Ergo,
because Ergo never sends the initial away state with `730`. Options: accept it; or seed it once per
newly watched peer (one `WHO nick` after its `730`), which `extended-monitor` then keeps current, so
it can't go stale the way a WHO-on-open snapshot without away reports would.
