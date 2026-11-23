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
3. `MONITOR` reports it online: its reported away state, then the answer to its away check (below),
   then a line it sent us as present. Otherwise, Luiz's rule: **unreported away state renders
   `away`** when the server will tell us when it changes (`extended-monitor` and `away-notify` both
   negotiated). On a server without them we can never learn it, so it renders `online`.
4. Otherwise: unknown (no `MONITOR`, list full, not yet answered, disconnected).

**Away check** (Luiz, 2026-11-21). Ergo never sends a peer's away state with its `730`, so each
watched peer reported online gets exactly one `WHO nick`; its `H` or `G` stands until the peer goes
offline, and `away-notify` reports changes after that. No `WHO` on DM open, none for a peer whose
away state papo already knows or who shares a channel with us (that channel's `WHO` reports it),
and another only after the peer goes offline and comes back. One
`WHO` is in flight at a time, so a reconnect that brings many peers online doesn't burst the
server; papo has no send pacing of its own. This fixes iris, a present peer sharing no channel.

## Look

One `PresenceMark` component (`app/src/ui/`) draws the mark wherever presence shows. Tokens only:

| State   | Person                                                    | Bot (robot icon)            |
|---------|-----------------------------------------------------------|-----------------------------|
| online  | filled dot, `--wl-color-online` fill and ring              | robot in `--wl-color-online`, filled badge |
| away    | crescent cut from a `--wl-color-panel-muted` disc          | muted robot, crescent badge |
| offline | hollow ring in `--wl-color-panel-muted`                    | muted robot, hollow badge   |
| unknown | no dot                                                    | robot in the row's text colour, no badge |

Option A of the F53 icon mocks (Luiz, 2026-11-21): shape tells all three states apart without
colour, which also suits n.e.'s yellow and greys. The crescent's bite is see-through, and the bot
badge (`--wl-size-presence-badge`) sits on a halo in the row's background (`--wl-presence-halo`).
The row's accessible name says the state ("ana, online").

Where it shows:

- desktop sidebar DM rows, the phone drawer and the switcher (`BufferPrefix`), as before;
- the phone chat list: the mark on the DM avatar's bottom-right corner (a bot's robot too), on a
  `--wl-color-surface` disc to separate it from the avatar; the row's label is unchanged;
- the DM header, desktop and phone: the mark, centred on the text, and "Online", "Away since
  14:05" or "Offline, last seen 14:05" (Luiz, F53 review); the phone header's accessible name says
  the same. Unknown keeps today's header (nothing on desktop, "Direct message" on the phone).

A time appears only for a change this session saw: an `AWAY` (at its server time), a quit, or a
`731` after the peer was reported online. A peer assumed away from a bare `730`, or already offline
when first watched, shows plain "Away" or "Offline"; reconnecting forgets the times, and nothing is
stored across restarts. The time is a server-time tag when the line has a valid one, otherwise the
moment we received the line; papo's `MONITOR` offline event carries no tag, so a `731` is always
dated on receipt. Either way it is when we saw the change, never a guess.

Wording (Luiz, 2026-11-21, absolute): "Away since 14:05" today, "since yesterday 23:50", "since
Mon" within the past week, "since 31 Oct" within the year, then "since Nov 2024"; "Offline, last
seen …" the same. Local calendar days decide the range. The label is worked out when shown and only
changes with the presence, so nothing ticks and the idle checks are unaffected.

The member list is unchanged: everyone in it shares the channel, so nobody is offline, and the
prototype groups Online and Away with away rows muted.

Contrast (marks are non-text UI, so 3:1 against the panel and the selected row): every theme
passes except `modern`'s existing online green on the selected row (2.8:1). Online against away is
a hue difference only, weakest in `lounge` (1.1:1 luminance, green against grey) and `n.e.` is
yellow against grey (1.7:1).

## Any IRC server

Presence uses only standard IRC and IRCv3, each gated on what the server advertises: `MONITOR`
(ISUPPORT), `extended-monitor` and `away-notify` (caps), plain `WHO` with its H/G flag (WHOX when
advertised), and `QUIT`. Without one of them it degrades rather than guessing:

- **No `MONITOR`:** nothing is watched, and a peer sharing no channel shows no mark.
- **No `extended-monitor` or `away-notify`:** the one `WHO` still gives the starting state, which
  stands with no time, since later changes won't be reported. Before it answers, the peer shows
  online rather than away. Not guessing "away" where the server can't report away is a **proposed
  default awaiting Luiz's OK**.
- **No or invalid server-time:** the change is dated when we received it.

Nothing in the presence path is Ergo-specific. One gap outside it: papo 40c6722's guarded DM handle
needs a `MONITOR` slot, so on a server without `MONITOR` a DM to a peer we can't verify fails like a
full `MONITOR` list does. That is a DM-sending and identity question, left for Luiz and papo.

## Out of scope

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

- The proposed default above: on a server that can't report away changes, show online until the
  `WHO` answers, then only what it said.
- DMs on a server without `MONITOR` (see "Any IRC server").
