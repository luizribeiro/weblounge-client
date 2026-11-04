export const messages = {
  "action.open": "Open",
  "common.away": "Away",
  "common.bot": "BOT",
  "common.cancel": "Cancel",
  "common.channel": "Channel",
  "common.send": "Send",
  "cmd.close.confirmation_action": "Leave",
  "cmd.close.confirmation_prompt": "Leave {text}?",
  "cmd.close.description": "Close this conversation",
  "cmd.close.usage": "/close",
  "cmd.cycle.description": "Leave and rejoin a channel",
  "cmd.cycle.usage": "/cycle [channel] [reason]",
  "cmd.debug.description": "Show or hide app diagnostics",
  "cmd.debug.usage": "/debug <viewport|gestures|keyboard|push|off>",
  "cmd.help.description": "Show available commands or command help",
  "cmd.help.usage": "/help [command]",
  "cmd.identify.description": "Identify with NickServ",
  "cmd.identify.usage": "/identify <password>",
  "cmd.join.description": "Join one or more channels",
  "cmd.join.usage": "/join <channels> [keys]",
  "cmd.me.description": "Send an action message",
  "cmd.me.usage": "/me <text>",
  "cmd.msg.description": "Send a private message",
  "cmd.msg.usage": "/msg <target> <text>",
  "cmd.nick.description": "Change your nickname",
  "cmd.nick.usage": "/nick <nickname>",
  "cmd.notice.description": "Send a notice",
  "cmd.notice.usage": "/notice <target> <text>",
  "cmd.part.confirmation_action": "Leave",
  "cmd.part.confirmation_prompt": "Leave {text}?",
  "cmd.part.description": "Leave a channel",
  "cmd.part.usage": "/part [channel] [reason]",
  "cmd.query.description": "Open a private conversation",
  "cmd.query.usage": "/query <nickname> [text]",
  "cmd.quit.confirmation_action": "Disconnect",
  "cmd.quit.confirmation_prompt": "Disconnect from this network?",
  "cmd.quit.description": "Disconnect from the network",
  "cmd.quit.usage": "/quit [reason]",
  "cmd.say.description": "Send text without treating it as a command",
  "cmd.say.usage": "/say <text>",
  "cmd.topic.description": "Show or change the channel topic",
  "cmd.topic.usage": "/topic [channel] [text]",
  "cmd.version.description": "Show this app build",
  "cmd.version.usage": "/version",
  "composer.empty_input": "Enter a message or command.",
  "composer.missing_argument": "That command needs more information.",
  "composer.unexpected_argument": "That command has an unexpected argument.",
  "composer.unknown_command": "Unknown command {input}.",
  "composer.confirm": "Confirm /{command}",
  "composer.input": "Message {target}",
  "composer.suggestions": "Suggestions for {target}",
  "composer.suggestions_available": "{count} suggestions available",
  "conversation.open_direct": "Open direct message with {nick}",
  "conversation.toggle_members": "Toggle member list",
  "conversation.toggle_sidebar": "Toggle channel list",
  "direct_identity.cannot_verify": "Can't verify this is the same {nick}",
  "direct_identity.changed": "This isn't the same {nick} — different account",
  "direct_identity.defer": "Not now",
  "direct_identity.trust": "Trust new identity",
  "engine.bouncer_network_limit_reached":
    "You can't add another network because this server's client state limit was reached.",
  "engine.buffer_not_sendable": "Messages can't be sent to this conversation.",
  "engine.cached_target_gone":
    "That conversation is no longer available, so the message was not sent.",
  "engine.channel_limit_reached":
    "You're in the maximum number of channels for this server.",
  "engine.channel_not_found": "That channel isn't available.",
  "engine.channel_recreated":
    "This channel was recreated while you were away. Verify its topic and members before trusting it.",
  "engine.channel_rejoin_required":
    "You were kicked from {target}. Rejoin to send messages.",
  "engine.channel_required": "That command only works in a channel.",
  "engine.command_failed": "Something went wrong. Try again.",
  "engine.command_refused": "The server refused that command.",
  "engine.connection_failed":
    "Couldn't connect to the server. Check the address, certificate, and whether this site is allowed.",
  "engine.dedicated_worker_fallback":
    "This browser uses one connection per tab because SharedWorker is unavailable.",
  "engine.direct_identity_mismatch":
    "That nickname's identity changed. Review it before sending.",
  "engine.direct_monitor_full":
    "Too many open conversations to verify this person. Close one to message them.",
  "engine.direct_presence_unavailable":
    "Presence updates are unavailable for this conversation.",
  "engine.direct_target_gone":
    "That person left or the nickname now belongs to someone else. Your message was not sent.",
  "engine.direct_unavailable":
    "That person isn't available for a private message.",
  "engine.hosted_auth_failed": "Your session expired. Signing in again.",
  "engine.invalid_endpoint": "That server address isn't valid.",
  "engine.join_banned": "Couldn't join {input}: you're banned.",
  "engine.join_refused": "Couldn't join {input}: that channel isn't available.",
  "engine.mark_read_failed": "Couldn't mark this conversation as read.",
  "engine.metadata_limit_reached":
    "That profile change exceeds this server's client state limit.",
  "engine.network_already_connected": "That network is already connected.",
  "engine.network_not_found": "That network is no longer available.",
  "engine.not_in_channel": "You're not in {target}.",
  "engine.offline": "That command needs a connection.",
  "engine.read_marker_invalid":
    "That read position isn't available on this server.",
  "engine.send_failed": "The message couldn't be sent.",
  "engine.state_inconsistent":
    "The conversation changed unexpectedly. Try again.",
  "engine.storage_unavailable": "Something went wrong. Try again.",
  "engine.unsupported_conversation": "That conversation isn't supported.",
  "engine.worker_failed": "Something went wrong. Try again.",
  "hosted.misconfigured": "This deployment is misconfigured.",
  "hosted.reset_app": "Reset app",
  "hosted.resetting": "Resetting weblounge…",
  "hosted.unreachable": "Can't reach weblounge. Check your connection.",
  "mobile.preview.own": "You: {text}",
  "messages.date.today": "Today",
  "messages.date.yesterday": "Yesterday",
  "messages.delivery.failed": "Failed",
  "messages.delivery.failed_retry": "Failed · Retry",
  "messages.delivery.sending": "Sending…",
  "messages.jump.many": "{count} new messages ↓",
  "messages.jump.one": "{count} new message ↓",
  "messages.label": "Messages",
  "messages.membership.joined": "joined",
  "messages.membership.kicked": "{actor} kicked you{reason}",
  "messages.membership.left": "left",
  "messages.membership.many": "{members} and {last}",
  "messages.membership.quit": "quit",
  "messages.membership.two": "{first} and {last}",
  "messages.new": "New",
  "messages.rejoin": "Rejoin",
  "messages.topic": "Topic: {topic}{setter}{time}",
  "messages.topic.empty": "No topic is set.",
  "messages.topic.setter": " — set by {setter}",
  "messages.topic_prefix": "Topic: ",
  "messages.unverified_sender": "Unverified sender",
  "notice.message_not_delivered": "Message to {target} wasn't delivered",
} as const;

export type MessageKey = keyof typeof messages;
export type MessageValue = string;
export type MessageValues = Readonly<Record<string, string | undefined>>;

const knownMessageKeys: ReadonlySet<string> = new Set(Object.keys(messages));

export function isMessageKey(key: string): key is MessageKey {
  return knownMessageKeys.has(key);
}

export function t(key: MessageKey, values: MessageValues = {}): string {
  return interpolate(messages[key], normalizeValues(key, values));
}

export function translate(key: string, values: MessageValues = {}): string {
  if (isMessageKey(key)) return t(key, values);
  console.error(`Missing message key: ${key}`);
  return key;
}

function interpolate(template: string, values: MessageValues): string {
  return template.replace(/\{([a-z_][a-z0-9_]*)\}/giu, (placeholder, name) => {
    const value = values[name];
    if (value !== undefined && value !== null) return String(value);
    console.error(`Missing value for message placeholder: ${name}`);
    return placeholder;
  });
}

function normalizeValues(
  key: MessageKey,
  values: MessageValues,
): MessageValues {
  if (key === "composer.unknown_command") {
    return { ...values, input: commandFrom(valueAsString(values.input)) };
  }
  if (key === "engine.join_banned" || key === "engine.join_refused") {
    return { ...values, input: joinTargetFrom(valueAsString(values.input)) };
  }
  if (
    (key === "cmd.close.confirmation_prompt" ||
      key === "cmd.part.confirmation_prompt") &&
    values.text === undefined
  ) {
    return { ...values, text: "this channel" };
  }
  if (key === "engine.channel_rejoin_required" && values.target === undefined) {
    return { ...values, target: "this channel" };
  }
  if (key === "notice.message_not_delivered" && values.target === undefined) {
    return { ...values, target: "that person" };
  }
  if (key === "mobile.preview.own" && values.text === undefined) {
    return { ...values, text: "" };
  }
  return values;
}

function valueAsString(
  value: MessageValue | null | undefined,
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function commandFrom(input: string | undefined): string {
  return input?.trim().split(/\s/u, 1)[0] || "that command";
}

function joinTargetFrom(input: string | undefined): string {
  return input?.trim().split(/\s+/u, 3)[1]?.split(",", 1)[0] || "that channel";
}
