# Command catalog

Status: draft. This merges five research passes: terminal clients, GUI clients, web clients, server/services and papo at rev `7d5e4bf`. It extends the registry in [14](14-commands-and-shortcuts.md) and gates commands through the capability model in [17](17-capability-model.md).

## Goals

- Give IRC veterans the slash commands, names and aliases they already type in irssi, WeeChat and HexChat. When those clients disagree, irssi and WeeChat win, and HexChat breaks remaining ties.
- Give Slack and Discord users the same actions through context menus and the Cmd+K palette. A context menu item and its slash command are one registry entry, never two code paths.
- Gate availability on papo `Feature`s, ISUPPORT and your channel prefix, never on raw cap strings. If a command is unavailable, its slash command, palette row and menu item are absent, not disabled ([17](17-capability-model.md)).

## Conventions

- **Current target by default.** Any leading `Channel` or `Target` argument can be left out and defaults to the focused buffer. The parser consumes that argument only when the token starts with a `CHANTYPES` character. Using `*` as a target also means the current buffer.
- **Comma lists.** `ChannelList`, `NickList` and `KeyList` accept `a,b,c`. papo's `join`, `kick` and `kickban` take one channel or nick per call, and so does a ban. The engine fans the list out for `join`, `kick`, `kickban` and `ban`. `op`, `deop`, `voice` and `devoice` can batch the whole list into one `SetModes` chain.
- **Literal slash.** `//text` and `/say text` send the line as typed.
- **Unknown commands.** Typing `/foo` does **not** send `FOO` raw to the server, which would leak typos. It shows "Unknown command". Doc 13 says the composer "never exposes a raw-command escape hatch". So an inline "Send `FOO …` to server" action is **Later**, and it needs sign-off to amend 13, the same as `/quote`. Ergo's `NS`, `CS`, `HS` and `HISTSERV` verbs are explicit catalog entries, so they never hit this path.
- **No prefix matching.** irssi's unambiguous-prefix matching (`/win` for `/window`) is not supported. Completion covers the same need without the ambiguity.
- **Password redaction.** Commands with a secret argument are kept out of composer history, drafts, logs and telemetry. The list:
  - `oper`
  - `identify`
  - `ns identify|register|passwd|set password`
  - `msg NickServ IDENTIFY|REGISTER|PASSWD|SET PASSWORD`
  - `bs sasl set-plain`
  - `bs user update -password`
  - `quote PASS|OPER|AUTHENTICATE`
- **Prompts for arguments.** When a menu action needs an argument (kick reason, ban mask, away message), it opens an inline prompt built from that argument's type, like mIRC's "Kick (why)".

### Legend

- **Argument types:** Nick, NickList, Channel, ChannelList, KeyList, Target (nick or channel), Mask, Text (rest of line, always last), Mode string, Integer, Duration, AccountName, NetworkName. Two types are added here:
  - **MessageRef**: the selected message, a msgid, or `last`.
  - **CommandName**: a registry entry name.
  - A `?` suffix marks an argument as optional.
- **Surfaces:** S = slash command, P = palette (Cmd+K). The context menus are U (User), M (Message), C (Channel/buffer) and N (Network).
- **Priority:**
  - M2 is the brief's vertical slice. The shipped M2 `ParsedInput` is Message, Me, Join, Part, Msg, Nick, Topic and Quit.
  - M2.5 is split view and shortcuts (PLAN). Its pane commands are TS-only in 14, so no rows here.
  - M3 is history and state.
  - M4 is hosted mode. It has no commands.
  - M5 is the rest of the product (Cmd+K, members panel, settings, push).
  - M6 is onboarding, including soju import.
  - Later and Never are as written.
- **Confirm:**
  - "yes" maps to `confirm(always)`: both the typed slash command and the GUI path confirm.
  - "menu" maps to `confirm`: only the GUI path confirms, because a typed slash command with explicit arguments is already deliberate.
  - "no" never confirms.
- **Permission:** anyone, halfop+, op (channel op, or the `PREFIX` rank that lets you set that mode), oper (server operator) and soju admin.

---

## Messaging

| Command | Aliases | Arguments | What it does | papo / capability | Pri | Surfaces | Perm | Confirm |
|---|---|---|---|---|---|---|---|---|
| say | (plain text) | Text | Sends text to the current buffer, including lines that start with `/` (`//` escape). | `Client::privmsg`; multiline via `draft/multiline` with `Fallback::SplitIntoLines` | M2 | S | anyone | no |
| msg | m, privmsg | Target, Text | Sends to a target. Creates or reuses the DM buffer (without focusing it). Service targets go through the services path and never get a DM buffer. | `Client::privmsg` | M2 | S, P | anyone | no |
| query | q | Nick, Text? | Opens (and focuses) a DM buffer and optionally sends the first line. | client-only + `Client::privmsg`; `MONITOR` the nick when `Feature::Monitor` | M3 | S, P, U ("Message") | anyone | no |
| me | — | Text | Sends a CTCP ACTION to the current buffer. | `Client::action` | M2 | S | anyone | no |
| describe | action | Target, Text | Sends an ACTION to a different target (irssi `/action <target> <text>`). | `Client::action` | Later | S | anyone | no |
| notice | — | Target, Text | Sends a NOTICE. | `Client::notice` | M3 | S | anyone | no |
| wallchops | wall, onotice | Channel?, Text | Sends a notice to the channel's ops only (`NOTICE @#chan`). | `Client::notice` to a STATUSMSG target; gated on `STATUSMSG` ISUPPORT | Later | S | anyone (op by convention) | no |
| shrug | tableflip | Text? | Appends `¯\_(ツ)_/¯` (or a table flip) and sends. Built for Slack/Discord users. | client-only + `privmsg` | Later | S | anyone | no |

## Channels

| Command | Aliases | Arguments | What it does | papo / capability | Pri | Surfaces | Perm | Confirm |
|---|---|---|---|---|---|---|---|---|
| join | j | ChannelList, KeyList? | Joins channels (adds a missing `#`), or focuses one you are already in. `-noswitch` joins without focusing. | `Client::join` per channel; resolves after sync | M2 | S, P, N ("Join channel…") | anyone | no |
| part | leave | Channel?, Text? | Actually leaves the channel. On always-on Ergo or soju this removes the membership server-side. | `Client::part` | M2 | S, P, C ("Leave channel") | anyone | menu (always-on: "You will stop receiving history") |
| cycle | rejoin, hop | Channel?, Text? | Parts and immediately rejoins. | `Client::part` then `Client::join` | Later | S, C | anyone | no |
| topic | t | Channel?, Text? | No text: shows the cached topic, setter and time. With text: sets the topic. `-delete` clears it. | channel state; `Client::set_topic`, `Client::clear_topic` | M2 | S, P, C ("Edit topic") | anyone, or halfop+ on `+t` channels | no |
| invite | — | Nick, Channel? | Invites a user. The prompt asks for whichever argument the context menu doesn't provide. | `Client::invite`; `Feature::InviteTracking` shows other users' invites | M5 | S, P, U ("Invite to channel…"), C ("Invite people…") | anyone, or op on `+i` channels | no |
| rename | — | Channel, Channel, Text? | Renames a channel in place, keeping members and history. | `Client::rename_channel`; `Feature::ChannelRename` (Ergo) | Later | S, C (channel settings) | op | menu |
| knock | — | Channel, Text? | Asks to be let into an invite-only channel. Ergo 2.19 has no KNOCK. | gap: raw `KNOCK`; gated on `KNOCK` ISUPPORT | Later | S | anyone | no |
| partall | — | Text? | Leaves every channel on the network. | client-only loop over `Client::part` | Later | S | anyone | menu |

## Users & presence

| Command | Aliases | Arguments | What it does | papo / capability | Pri | Surfaces | Perm | Confirm |
|---|---|---|---|---|---|---|---|---|
| nick | — | Nick | Changes your nick. Ergo's nick reservation can refuse it, and the typed `Refusal` is shown inline. | `Client::set_nick` | M2 | S, P, N | anyone | no |
| away | — | Text? | With text: sets away. Without text: clears it (irssi, WeeChat, mIRC behavior). `-all` applies to every network. | `Client::set_away`, `Client::clear_away`; `Feature::PreAway` for backgrounded mobile | M3 | S, P, N (status picker) | anyone | no |
| back | — | — | Clears away (irssi/HexChat). | `Client::clear_away` | M3 | S | anyone | no |
| setname | realname | Text | Changes your realname (display name) live. | `Client::set_realname`; `Feature::SetName` | M5 | S, P (also a Settings > Profile field) | anyone | no |
| notify | monitor, watch | NickList | Adds nicks to the presence list ("Notify when online"). `-del` (alias `unnotify`) removes them. | `Client::monitor().add` / `.remove`; `Feature::Monitor`; extended-monitor for away and account; respect the server's limit | M5 | S, P, U ("Notify when online") | anyone | no |
| accept | — | NickList | Ergo caller-ID (`+g`): allows DMs from these users. `-nick` revokes. | gap: raw `ACCEPT`; gated on `CALLERID` ISUPPORT | Later | S, U ("Allow DMs") | anyone | no |

## Moderation (ops)

These commands are visible only when your rank in the focused channel allows the mode. Rank comes from `PREFIX` and the ISUPPORT-backed features named in each row.

| Command | Aliases | Arguments | What it does | papo / capability | Pri | Surfaces | Perm | Confirm |
|---|---|---|---|---|---|---|---|---|
| kick | k | Channel?, NickList, Text? | Removes users from the channel. | `Client::kick(channel, nick, reason)`, one nick per call (engine fans out) | M5 | S, P, U ("Kick…") | halfop+ | menu (asks for a reason) |
| kickban | kb | Channel?, NickList, Text? | Bans, then kicks once the ban is confirmed. The ban mask follows the ban-type setting. | `Client::kickban(channel, nick, BanTarget, reason)` → `KickbanOutcome`, one nick per call (engine fans out); account extban needs `Feature::AccountExtban` | M5 | S, P, U ("Kick and ban…") | op | menu |
| ban | — | Channel?, (Nick \| Mask \| AccountName)? | No args: opens the ban list. With args: sets `+b`. A nick becomes a mask derived from cached user@host, or an account extban when it is available and the user is logged in. | `SetModes::ban`; `Extban::account`; one target per ban (engine fans out) | M5 | S, P, U ("Ban…") | op | menu |
| unban | ub | Channel?, Mask \| Nick \| Integer | Removes a ban by mask, nick, or ban-list index. `*` removes all (alias `mub`). | `SetModes::unban` | M5 | S, C (ban list rows) | op | yes for `*`, otherwise no |
| quiet | — | Channel?, (Nick \| Mask)? | No args: lists quiets. With args: mutes the user (dedicated `+q` list where one exists, Ergo `m:` extban otherwise). | `SetModes::quiet`; `Feature::Quiet` (dedicated list only). **Ergo: gap**, see papo gaps | M5 | S, P, U ("Mute in channel…") | op | menu |
| unquiet | — | Channel?, Nick \| Mask | Removes a quiet. | `SetModes::unquiet` | M5 | S, U | op | no |
| op / deop | — | Channel?, NickList | Gives or takes `+o`. | `SetModes::op` / `deop`, the whole list in one chain | M5 | S, P, U ("Make op" / "Remove op") | op | no |
| halfop / dehalfop | — | Channel?, NickList | Gives or takes `+h`. Has no `hop` alias, because `/hop` means cycle. | `SetModes::halfop` / `dehalfop`; `Feature::Halfop` | M5 | S, U | op | no |
| voice / devoice | — | Channel?, NickList | Gives or takes `+v`. | `SetModes::voice` / `devoice`, the whole list in one chain | M5 | S, P, U ("Give voice" / "Remove voice") | halfop+ | no |
| mode | umode (own nick) | Target?, Mode string? | No mode string: shows the modes from channel state. With one: sets modes, validated against `CHANMODES` and `PREFIX`. | `Client::mode(...).add/remove/add_with/remove_with`; partial result via `ModesApplied::is_complete`. Raw string parsing is client-side | M5 | S, C ("Channel settings…" dialog) | op (channel), anyone (self) | no |
| banlist | bans, exceptlist, invexlist, quietlist | Channel? | Fetches and shows a list mode (`+b`, `+e`, `+I`, `+q`). | `Client::list_modes(ListMode::…)`; `Feature::Excepts`, `Feature::Invex`, `Feature::Quiet`. `list_modes` returns `Error::StateLimit` after 1,000 rows (no partial list) | M5 | S, C ("Bans and exceptions…") | anyone (op to edit) | no |
| except / invex | — | Channel?, Mask | Adds a ban exception or invite exception. The `-` form removes it. | `SetModes::ban_exception`, `invite_exception`; `Feature::Excepts` / `Feature::Invex` | Later | S, C (list editor) | op | no |
| knockout | — | Channel?, Duration, Nick, Text? | Timed kickban. The client lifts the ban after the duration. | client-only timer + `kickban`/`unban`; lost if the device closes (question for Luiz) | Later | S, U ("Kick and ban for…") | op | menu |
| remove | — | Channel?, Nick, Text? | Force-part (Solanum). Ergo lacks it. | gap: raw `REMOVE`; hidden unless the server advertises it | Later | S | op | menu |
| oper | — | AccountName, Text? | Becomes an IRC operator. The password is redacted. | `Client::oper(name, Secret)` | Later | S | anyone | no |
| kill | — | Nick, Text | Disconnects a user. | gap: raw `KILL` | Later | S, U (Oper submenu) | oper | menu |
| uban | kline, dline | Text | Ergo unified network ban (add, del, list, info). | pass-through raw `UBAN` | Later | S, U (Oper > "Network ban…") | oper | menu |
| wallops | — | Text | Sends a WALLOPS to opers. | pass-through raw `WALLOPS` | Later | S | oper | no |
| sajoin / sanick / samode | — | Text | Oper overrides. | pass-through raw | Later | S | oper | no |

## Information

| Command | Aliases | Arguments | What it does | papo / capability | Pri | Surfaces | Perm | Confirm |
|---|---|---|---|---|---|---|---|---|
| whois | wi | Nick | Shows user info (account, realname, channels with rank, idle, away, server). Backs the profile popover. | `Client::whois` → typed `Whois` | M3 | S, P, U ("View profile") | anyone | no |
| wii | — | Nick | WHOIS asked of the user's own server, for remote idle time. | gap: `whois` takes no server arg; raw `WHOIS n n` | Later | S | anyone | no |
| whowas | ww | Nick, Integer? | Shows info about a nick that has left. | gap: raw `WHOWAS` | Later | S | anyone | no |
| who | w | Channel \| Mask | Lists matching users. On a joined channel it also refreshes member facts. | `Client::who` (WHOX) | Later | S | anyone | no |
| names | n | Channel? | Prints channel members. In the GUI, it opens the members panel. | channel state (no typed NAMES needed) | M5 | S, P, C ("Members") | anyone | no |
| list | channels, browse | Text? (mask or ELIST filter) | Opens the channel browser dialog (sortable, filterable, join on Enter). | `Client::list` (max 10,000). ELIST filters are untyped (gap) | Later | S, P, N ("Browse channels…") | anyone | no |
| motd | — | — | Shows the MOTD in the server buffer. | `event::Motd` at connect. Refetch is a gap (raw `MOTD`) | M3 | S, N ("Server info") | anyone | no |
| lusers / version / time / info / admin / links / stats | — | Text? | Server queries (irssi semantics: `/version` and `/time` ask the server). Replies render in the server buffer. | gap: raw pass-through | Later | S | anyone | no |
| helpop | — | Text? | Server help (`HELP`/`HELPOP`), shown in a help panel. `/help` stays client help. | gap: raw `HELP` (labeled via `request_raw`) | Later | S | anyone | no |
| lag | — | — | Shows round-trip time. Mainly a status-bar indicator. | `Client::ping` → `Duration` | Later | S, N | anyone | no |
| ctcp | ping | Nick, Text | CTCP query (VERSION, PING, TIME, CLIENTINFO only). `/ping nick` is CTCP PING, as in irssi. | gap: no typed outgoing CTCP; `send_raw` with `\x01` framing. Replies use `CtcpReplies` | Later | S, U (CTCP submenu, hidden by default) | anyone | no |
| cap | — | — | Shows negotiated caps and derived features (diagnostics). | client state (`FeaturesChanged`) | Later | S, N ("Connection info") | anyone | no |

## Account & services

Ergo implements `NS`, `CS`, `HS` and `HISTSERV` as real IRC verbs. The client detects Ergo from the `004`/`RPL_MYINFO` version prefix `ergo-` and then sends the verb. This is a server-identity check, not a `Feature` or ISUPPORT token, so it is named here explicitly. When the server is unknown, the client falls back to `PRIVMSG NickServ` (and so on). On Ergo a PRIVMSG is avoided because it could reach a nick squatter. Service traffic never creates a DM buffer. Replies arrive as NOTICEs, and the client shows them inline (or in a Services panel), not in a DM tab.

| Command | Aliases | Arguments | What it does | papo / capability | Pri | Surfaces | Perm | Confirm |
|---|---|---|---|---|---|---|---|---|
| ns | nickserv | Text | Talks to NickServ. Completes subcommands from a static per-server table. | pass-through to services (`send_raw("NS …")` on Ergo, else `privmsg`) | M3 | S | anyone | no (typed); GUI drop is menu |
| cs | chanserv | Text | Talks to ChanServ. | pass-through to services | M3 | S | anyone | no (typed); GUI unregister/transfer/clear are menu |
| hs | hostserv | Text | Talks to HostServ. weblounge disables HS ON/OFF (concierge owns vhosts). | pass-through to services | Later | S | anyone | no |
| histserv | — | Text | Talks to HistServ. Never send Ergo's `HISTORY` verb, because its replay breaks dedupe. This is the only path to `HISTSERV DELETE`. | pass-through to services | Later | S | anyone (owner); oper for forget/export | no (typed) |
| identify | id | AccountName?, Text | `NS IDENTIFY`. Never needed on weblounge (SASL is required). The password is redacted. On generic servers the client offers "Save as SASL credentials" instead. | pass-through to services | Later | S | anyone | no |
| regain | ghost, recover | Nick | Reclaims a nick your account owns. Also offered as a prompt on `433`. | pass-through. On Ergo it sends `NS GHOST`; on Atheme/Anope it sends REGAIN/RECOVER | Later | S, inline prompt | anyone | no |
| (account info) | — | AccountName | `NS INFO`, shown on the profile card. | pass-through to services | Later | U ("Account info") | anyone | no |
| (register channel) | — | Channel? | `CS REGISTER`, offered when you are op and the channel is unregistered. | pass-through to services | Later | C ("Register channel") | op | menu |
| (persistent role) | — | Channel?, AccountName, Mode string | `CS AMODE`: a persistent op, halfop or voice role. | pass-through to services | Later | U ("Make op permanently"), C (Roles) | founder or admin | menu for removal |
| (restore privileges) | — | Channel? | `CS OP` on yourself. | pass-through to services | Later | C | amode holder | no |
| (ask ChanServ to invite) | — | Channel | `CS INVITE`, offered when JOIN fails with `473`. | pass-through to services | Later | inline prompt | amode holder | no |
| (sessions and devices) | — | — | `NS SESSIONS` / `NS CLIENTS LOGOUT` as a Settings > Devices page. | pass-through + reply parsing (gap) | Later | Settings only | anyone | menu for logout |
| (stay connected) | — | — | Always-on toggle. | `Client::persistence` (**unstable**, `Feature::Persistence`), else `NS SET ALWAYS-ON` | Later | Settings only | anyone | no |
| register / verify | — | — | Account creation. Not offered on weblounge (concierge). Elsewhere it is a sign-up form, never a slash command, so the password stays out of history. | `Client::create_account` / `verify_account`; `Feature::AccountCreation` | M6 | onboarding form | anyone | no |

## Bouncer (soju)

These commands are visible only on a soju connection (`Feature::Bouncer`, **unstable**).

| Command | Aliases | Arguments | What it does | papo / capability | Pri | Surfaces | Perm | Confirm |
|---|---|---|---|---|---|---|---|---|
| network | networks | NetworkName? | No args: lists networks. With a name: switches to it. | client state over `Client::bouncer().networks()`; `Feature::Bouncer` (**unstable**) | M3 | S, P | anyone | no |
| network add | — | Text (`host[:port]`, `name=` and so on) | Adds an upstream network. In the GUI this is the "Add network…" dialog. | `Bouncer::add`; `Feature::Bouncer` (unstable) | M6 | S, P, N ("Add network…") | anyone | no |
| network edit | — | NetworkName, Text | Changes nick, realname, address, enabled. | `Bouncer::change`; `Feature::Bouncer` (unstable) | M6 | S, N ("Network settings…") | anyone | no |
| network del | — | NetworkName | Removes an upstream network. | `Bouncer::remove`; `Feature::Bouncer` (unstable) | M6 | S, N ("Remove network") | anyone | menu |
| bs | bouncerserv | Text | Talks to BouncerServ (sasl, certfp, user, channel...). | pass-through to services (`privmsg BouncerServ`) | M6 | S | anyone; soju admin for `user`/`server` | no (typed); GUI delete is menu |
| detach | — | Channel? | Hides a channel while soju stays joined. `/attach` or rejoin brings it back. | gap: BouncerServ text `channel update -detached true` | Later | S, C ("Hide channel (stay joined)") | anyone | no |
| attach | — | Channel | Reattaches a detached channel. | gap: as above | Later | S | anyone | no |
| (upstream SASL) | — | NetworkName, AccountName, Text | `bs sasl set-plain`. The password is redacted. | gap: BouncerServ text | Later | Network settings > Credentials | anyone | no |

## Client

| Command | Aliases | Arguments | What it does | papo / capability | Pri | Surfaces | Perm | Confirm |
|---|---|---|---|---|---|---|---|---|
| help | ? , commands | CommandName? | Lists commands, or shows the usage and argument help for one, generated from the registry. | client-only | M3 | S, P | anyone | no |
| quote | raw | Text | Sends a raw IRC line. Uses labeled replies when available. Raw `CAP` is refused so papo state cannot desync. Hidden from the palette unless "Show advanced commands" is on. **Needs sign-off to amend 13**, which says the composer "never exposes a raw-command escape hatch". | `Client::send_raw` / `Client::request_raw` (labeled-response) | Later | S | anyone | no |
| close | wc | — | Closes the buffer. Query: hides it locally (until new activity). Channel: same as `part` (irssi, gamja). On soju, the menu offers "Detach" as the soft option. | client-only (+ `part`) | M3 | S, P, C ("Close") | anyone | menu (channels) |
| clear | c, cl | — (`-all`) | Clears the local view only. Scrollback can still be refetched from chathistory. | client-only | M3 | S, P, C ("Clear view") | anyone | menu |
| switch | buffer, goto, window | Target \| Integer | Jumps to a buffer by name or index. This is the palette's quick switcher. | client-only | M5 | S, P | anyone | no |
| ignore | ig | Nick \| Mask, Duration? | Hides messages from a user. Client-side, synced (see questions). In the GUI: "Block/Mute user". `/ignore` with no args lists ignores. | client-only (Ergo 2.19 has no SILENCE) | M5 | S, P, U ("Ignore") | anyone | no |
| unignore | — | Nick \| Mask \| Integer | Removes an ignore. | client-only | M5 | S, U | anyone | no |
| highlight | hilight | Text | Adds a highlight keyword. No args lists them. | client-only (settings) | M5 | S, P | anyone | no |
| dehighlight | dehilight | Text \| Integer | Removes a highlight keyword. | client-only | M5 | S | anyone | no |
| mute | — | Target? | Mutes notifications for a buffer (the Slack/Discord meaning, as in The Lounge). A quiet on a user is `/quiet`. | client-only (+ push filter) | M5 | S, P, C ("Mute") | anyone | no |
| unmute | — | Target? | Restores notifications. | client-only | M5 | S, C | anyone | no |
| notify-level | — | Target?, Text (`all\|mentions\|none`) | Sets the buffer's notification level (WeeChat `/buffer notify`). | client-only | M5 | C ("Notifications ›") | anyone | no |
| settings | set | Text? | Opens Settings. `/set key value` changes a setting with fuzzy key completion. | client-only | M5 | S, P | anyone | no |
| reconnect | — | NetworkName? | Reconnects now, skipping backoff. | `Client::reconnect` | M3 | S, P, N ("Reconnect") | anyone | no |
| disconnect | — | NetworkName?, Text? | Disconnects one network on this device only. With always-on, your presence stays. | `Client::quit` | M3 | S, P, N ("Disconnect") | anyone | menu |
| quit | exit, bye, signoff | Text? | Disconnects the current network on this device. It maps to 13's `network.disconnect`, the same action as `/disconnect` with no NetworkName. `-all` disconnects every network. Signing out is a separate Settings action. | `Client::quit` (per network with `-all`) | M2 | S, P | anyone | yes (`-yes` skips it, as in WeeChat) |
| alias | unalias | Text | User aliases with `$1`, `$2-`, `$C` and `$N` substitution. They expand into registry commands only and can never shadow a built-in. | client-only | Later | S, Settings | anyone | no |
| echo | — | Text | Prints a local line. Mainly useful for testing aliases. | client-only | Later | S | anyone | no |

## IRCv3 extras

| Command | Aliases | Arguments | What it does | papo / capability | Pri | Surfaces | Perm | Confirm |
|---|---|---|---|---|---|---|---|---|
| reply | re | MessageRef, Text | Sends a reply threaded to the message. The menu sets the composer's reply chip. | `Client::reply`; `Feature::Replies` (`Fallback::ReplyTagDropped`) | M5 | S, P, M ("Reply") | anyone | no |
| react | — | MessageRef, Text (emoji) | Adds a reaction. With no MessageRef, it uses the selected or last message. | `Client::react`; `Feature::Reactions` (`TagDenied` → absent) | M5 | S, M ("React…") | anyone | no |
| unreact | — | MessageRef, Text | Removes your reaction. In the GUI, toggled from the reaction chip. | `Client::unreact` | M5 | S | anyone | no |
| redact | delete | MessageRef, Text? | Deletes a message. | `Client::redact(message, reason)`; `Feature::Redaction`; absent otherwise | M5 | S, P, M ("Delete message") | own message; op for others | menu |
| markread | read | Target? \| `all` | Marks the buffer, or every buffer, read and syncs across devices. Also happens automatically while viewing. | `Client::mark_read(target, time)`; `Feature::ReadMarkers`, else 17's `MarkReadAction::LocalOnly` | M3 | S, P, C ("Mark as read"), N ("Mark all read") | anyone | no |
| (mark unread from here) | — | MessageRef | Local-only, because the server marker can only move forward. | client-only | M5 | M ("Mark unread") | anyone | no |
| search | find, grep, lastlog, ll | Text (`from:` / `in:` filters) | Searches history. Uses soju search where it exists. On Ergo it searches the locally fetched chathistory. weblounge's Ergo has DM history disabled (PLAN task 8), so client-side search cannot cover DMs. | gap: papo-core routes `soju.im/search` batches (unstable only); there is no `Client` API. Ergo has no search extension | Later | S, P, C ("Search in channel") | anyone | no |
| (reply privately) | — | MessageRef, Text | DM to the author with `+draft/channel-context`. | `SendMessage::channel_context` (`Fallback::ContextTagDropped`) | Later | M ("Reply privately") | anyone | no |
| (copy text) | — | MessageRef | Copies the message text. | client-only | M5 | M | anyone | no |
| (copy link) | — | MessageRef | Copies a message permalink. Waits until a weblounge msgid URL format is defined, because IRC has no standard message URL. | client-only | Later | M | anyone | no |
| upload | — | — (file picker) | Uploads a file and posts the link. Needs a filehost. | gap: no filehost API in papo (`soju.im/FILEHOST`); Ergo has none | Later | S, composer button | anyone | no |
| metadata | — | Target, Text | Avatar, display name, pronouns. Mostly through Profile settings. | `Client::metadata` (`Feature::Metadata`); confirm Ergo 2.19 support | Later | S, Settings | anyone | no |
| (jump to date) | — | Text (date) | Scrolls to a point in time with CHATHISTORY AROUND. | `History::around` | Later | P, C | anyone | no |

**Implicit, never commands:**
- CHATHISTORY paging and TARGETS (`Client::history`, `recent_conversations`)
- typing (`Client::typing`, a privacy toggle in Settings)
- WEBPUSH (`Client::webpush`, unstable, in Settings > Notifications)
- EXTJWT
- incoming RELAYMSG/NPC rendering (`Feature::Relay`, **unstable**)

---

## Not supported

| What | Why |
|---|---|
| DCC (send, chat, get) | Can't work in a browser. Uploads replace "Send file". |
| CTCP beyond VERSION/PING/TIME/CLIENTINFO (FINGER, USERINFO, SOURCE), CTCP to channels, flood-style CTCP | Privacy leak and abuse vector. CTCP is fading in modern clients (gamja, goguma and senpai don't have it). |
| amsg, ame, allchan, allserv, mass `mkick`/`mop`/`mdeop` | Spam and footguns. Use multi-select in the members panel if it's ever needed. |
| Scripting: exec, sysinfo, np, timer, delay, perform, uselect, plugins | No shell in the browser, and a security surface. Aliases (Later) cover the useful part. |
| Window management: `/window` move/split/size, `/layout`, `/gui`, `/sb`, `/bind` | Panes, the sidebar, drag-to-reorder and keybinding settings ([14](14-commands-and-shortcuts.md)) own this. `/switch` stays. |
| `/format` (Halloy) | The composer handles formatting ([13](13-composer.md)). |
| `/url`, `/browse` | Pointless in a web client. |
| `/silence` | Ergo 2.19 and soju don't implement it. `/ignore` is client-side. |
| `/ms`, `/memoserv` | Ergo has no MemoServ. DMs to always-on accounts are delivered on reconnect. |
| `/server host port` and `/connect host` creating ad-hoc connections | Networks come from onboarding (M6) or soju `network add`, not from typing a host. |
| Raw `HISTORY` / `CHATHISTORY` / `CAP` / `WEBPUSH` / `PERSISTENCE` lines via `/quote` | They break dedupe or desync papo state. `/quote` (Later) refuses `CAP` and warns on the rest. |
| `NS REGISTER` / `PASSWD` / `UNREGISTER`, `HS ON/OFF` on weblounge | Disabled on the server, and concierge owns them. The GUI links to the concierge account page. They stay reachable on other servers through `/ns` and `/hs`. |
| `/knock` on Ergo | Not implemented. On `473` the client offers `CS INVITE` or a DM to the ops instead. |

---

## Context menus for Slack/Discord users

Every item is a catalog entry. An item is hidden when its availability is unavailable ([17](17-capability-model.md)), and an item that needs an argument opens a typed inline prompt.

**Scheduling note (needs Luiz's sign-off):** brief §1 lists context menus, WHOIS/user profiles, moderation UI, search, uploads and the channel browser as "Explicitly later". This doc deliberately pulls context menus forward to the priorities in the tables (View profile M3, the moderation submenu M5, the message menu M5). If that is not approved, the U/M/C/N menu surfaces become Later and the slash priorities stay as they are.

**User menu** (nick in messages, members panel, DM header)
1. View profile → `whois`
2. Message → `query`
3. Mention → client-only (inserts `nick: ` into the composer)
4. Copy nick → client-only
5. Invite to channel… → `invite`
6. Notify when online → `notify`
7. Ignore → `ignore` / `unignore`
8. *Moderation* (shown only for ops): Make op / Remove op → `op`/`deop`; Give voice / Remove voice → `voice`/`devoice`; Mute in channel… → `quiet`; Kick… → `kick`; Ban… → `ban`; Kick and ban… → `kickban`; Make op permanently → `cs` AMODE (Later)
9. *Oper* (shown only for opers): Network ban… → `uban`; Disconnect user… → `kill`

**Message menu** (hover toolbar, right-click, long-press)
1. React… → `react`
2. Reply → `reply`
3. Reply privately → `(reply privately)` (Later)
4. Copy text → `(copy text)` (Copy link → `(copy link)` Later, once a weblounge msgid URL format exists)
5. Mark unread → `(mark unread from here)`
6. Delete message → `redact` (own message, or op)
7. Author ▸ → User menu

**Channel menu** (sidebar row, buffer header; also used for DMs)
1. Mark as read → `markread`
2. Open in new pane → 14's `pane.open-buffer-right` (M2.5)
3. Mute / Notifications ▸ → `mute`, `notify-level`
4. Edit topic → `topic`
5. Invite people… → `invite`
6. Members → `names`
7. Search in channel → `search` (Later)
8. Channel settings… → `mode` dialog, `banlist`, `rename`, `(register channel)`
9. Hide channel (stay joined) → `detach` (soju only)
10. Clear view → `clear`
11. Leave channel → `part` (for a query: Close → `close`)

**Network menu** (network header, server buffer)
1. Join channel… → `join`
2. Browse channels… → `list` (Later)
3. Mark all read → `markread all`
4. Set away / Back → `away` / `back`
5. Change nick… → `nick`
6. Server info → `motd`, `lag`, `cap`
7. Network settings… → `network edit` (soju), Settings
8. Add network… → `network add` (soju)
9. Reconnect → `reconnect`
10. Disconnect → `disconnect`
11. Remove network → `network del` (soju)

---

## Declarative definition

The engine owns the command table as one Rust enum: one variant per command, with a derive macro reading the attributes. From that enum the derive generates:

- the slash parser and its error messages,
- completion,
- `/help` text, using `t()` keys only,
- the menu and palette placements,
- the availability predicate,
- the `CommandId` and `CommandArgs` unions consumed by the TS registry in [14](14-commands-and-shortcuts.md).

UI-only commands from 14 (pane and focus commands) stay in TS.

```rust
#[derive(Command)]
pub enum IrcCommand {
    #[command(name = "join", aliases = ["j"], usage = "cmd.join.usage", about = "cmd.join.about",
              surfaces(slash, palette, menu = Network), permission = Anyone, milestone = M2)]
    Join { channels: ChannelList, keys: Option<KeyList> },

    #[command(name = "kick", aliases = ["k"], usage = "cmd.kick.usage", about = "cmd.kick.about",
              requires = Rank::HalfOp, surfaces(slash, palette, menu = User), confirm)]
    Kick {
        #[arg(default = current_channel)] channel: Channel,
        nicks: NickList,
        reason: Option<Text>,
    },

    #[command(name = "react", usage = "cmd.react.usage", about = "cmd.react.about",
              requires = Feature::Reactions, surfaces(slash, menu = Message), milestone = M5)]
    React {
        #[arg(default = selected_or_last)] message: MessageRef,
        emoji: Text,
    },
}

pub trait Arg: Sized {
    fn parse(tokens: &mut Tokens, cx: &ArgContext) -> Result<Self, ArgError>;
    fn complete(prefix: &str, cx: &ArgContext) -> Vec<Completion>;
    fn prompt() -> PromptKind; // how a context menu asks for a missing value
}
```

The macro enforces these rules at compile time:

- `Text` must be the last field.
- At most one optional `Channel`/`Target` may lead the variant. It is consumed only when the token matches `CHANTYPES`, which is what makes irssi's `[#chan] nick` order work.
- Aliases must be unique across the enum, and a generated test asserts this as well.

`requires` accepts a papo `Feature`, a `Rank`, `Oper`, or `Connection::Soju`, and resolves through the `NetworkActions`, `BufferActions` and `MessageActions` in 17. `confirm` (the legend's "menu") marks the variant for a confirmation dialog in menus. `confirm(always)` (the legend's "yes") also confirms the typed slash command. Only `quit` (skippable with `-yes`) and `unban *` use it.

Pass-through commands (`ns`, `cs`, `hs`, `histserv`, `bs`, `quote`) are ordinary variants with a single `Text` field. The handler decides between the native verb and a PRIVMSG.

---

## papo gaps (questions for Luiz)

1. **Ergo mute.** `Feature::Quiet` requires a dedicated quiet list in `CHANMODES`, and Ergo uses `+b m:mask`. `Extban` only has `account`. Should papo grow `Extban::mute`, or should the client build `m:` masks with `SetModes::add_with('b', …)`?
2. **Nick-to-mask for bans.** papo doesn't derive ban masks from a nick. Should a ban-type helper live in papo or in the engine?
3. **Untyped queries.** These all go through `send_raw`/`request_raw`: NAMES, a MOTD refetch, WHOWAS, WHOIS with a server argument (`/wii`), USERHOST, ISON, KNOCK, TIME, VERSION, LUSERS, INFO, ADMIN, HELP, ACCEPT, KILL, the `/mode #chan` query and ELIST filters. That's fine for the long tail. Do any deserve typed methods, for example `motd()` for the Server info panel?
4. **Outgoing CTCP.** There is no typed CTCP query apart from ACTION. Is a typed `ctcp(target, Ctcp::Version)` worth adding, or is raw framing fine for a Later feature?
5. **Search.** papo-core routes `soju.im/search` batches (unstable only; `tests/soju_search.rs` only tests batch routing). There is no `Client` API, and Ergo has no search extension. weblounge's Ergo also has DM history disabled (PLAN task 8), so client-side search can't cover DMs. Should `Client::search` be exposed? On Ergo, is client-side search over fetched channel history acceptable?
6. **Services replies.** Settings pages for NS SET/GET, sessions, AMODE and BouncerServ sasl/certfp/channel detach all mean parsing NOTICE text. Should papo offer typed service wrappers, using labeled-response to correlate replies, or should the engine own this?
7. **Unstable modules.** Bouncer networks (`Feature::Bouncer`), relay (`Feature::Relay`), persistence and webpush are behind papo's `unstable` feature. M3 multi-network on soju and M5 Web Push both depend on them. When should they stabilize, or should the engine enable `unstable` for now?
8. **Filehost.** There is no `soju.im/FILEHOST` support, and Ergo has no filehost. Does `/upload` wait for an external weblounge filehost (EXTJWT)?
9. **Where the table lives.** Doc 14 defines the registry in TS. Is a Rust derive that generates the TS unions (and TS-only UI commands alongside them) acceptable, or should the macro idea stay TS-side as codegen from a single table?

## Decisions (Luiz, 2026-10-28)

- The command table lives in Rust: a derive macro on the `Command` enum produces `CommandSpec`s and the generated TS types; UI-only actions are declared in TS and join the same action registry (memory: task 6c naming).
- `/close` on a channel parts it (irssi/gamja behaviour), with a menu confirmation on always-on servers.
- The ignore list is per device for now; syncing is decided together with settings sync.
- `/hop` is an alias of `/cycle`.
- The first dogfoodable version doesn't need everything: papo gaps 1-8 above are questions for papo, not blockers.
