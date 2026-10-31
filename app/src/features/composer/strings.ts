export interface MessageValues {
  readonly input?: string;
  readonly network_id?: string;
  readonly target?: string;
  readonly text?: string;
}

export const messageKeys = [
  "composer.empty_input",
  "composer.missing_argument",
  "composer.unknown_command",
  "engine.join_banned",
  "engine.buffer_not_sendable",
  "engine.channel_recreated",
  "engine.channel_required",
  "engine.command_refused",
  "engine.connection_failed",
  "engine.hosted_auth_failed",
  "engine.dedicated_worker_fallback",
  "engine.direct_target_gone",
  "engine.direct_monitor_full",
  "engine.direct_presence_unavailable",
  "engine.direct_unavailable",
  "engine.invalid_endpoint",
  "engine.network_already_connected",
  "engine.network_not_found",
  "engine.offline",
  "engine.send_failed",
  "engine.state_inconsistent",
  "engine.unsupported_conversation",
  "engine.worker_failed",
  "engine.command_failed",
] as const;

export const noticeKeys = ["notice.message_not_delivered"] as const;
export const actionKeys = ["action.open"] as const;

export type MessageKey =
  | (typeof messageKeys)[number]
  | (typeof noticeKeys)[number]
  | (typeof actionKeys)[number];

const knownMessageKeys: ReadonlySet<string> = new Set([
  ...messageKeys,
  ...noticeKeys,
  ...actionKeys,
]);

export function isMessageKey(key: string): key is MessageKey {
  return knownMessageKeys.has(key);
}

const commandStrings: Readonly<Record<string, string>> = {
  "cmd.close.confirmation_action": "Leave",
  "cmd.close.description": "Close this conversation",
  "cmd.close.usage": "/close",
  "cmd.cycle.description": "Leave and rejoin a channel",
  "cmd.cycle.usage": "/cycle [channel] [reason]",
  "cmd.debug.description": "Show or hide viewport diagnostics",
  "cmd.debug.usage": "/debug <viewport|off>",
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
  "cmd.part.description": "Leave a channel",
  "cmd.part.confirmation_action": "Leave",
  "cmd.part.usage": "/part [channel] [reason]",
  "cmd.query.description": "Open a private conversation",
  "cmd.query.usage": "/query <nickname> [text]",
  "cmd.quit.description": "Disconnect from the network",
  "cmd.quit.confirmation_action": "Disconnect",
  "cmd.quit.confirmation_prompt": "Disconnect from this network?",
  "cmd.quit.usage": "/quit [reason]",
  "cmd.say.description": "Send text without treating it as a command",
  "cmd.say.usage": "/say <text>",
  "cmd.topic.description": "Show or change the channel topic",
  "cmd.topic.usage": "/topic [channel] [text]",
};

export function t(key: string, values: MessageValues = {}): string {
  if (
    key === "cmd.close.confirmation_prompt" ||
    key === "cmd.part.confirmation_prompt"
  )
    return `Leave ${values.text ?? "this channel"}?`;
  const commandString = commandStrings[key];
  if (commandString !== undefined) return commandString;
  switch (key) {
    case "composer.empty_input":
      return "Enter a message or command.";
    case "composer.missing_argument":
      return "That command needs more information.";
    case "composer.unknown_command":
      return `Unknown command ${commandFrom(values.input)}.`;
    case "engine.join_banned":
      return `Couldn't join ${joinTargetFrom(values.input)}: you're banned.`;
    case "engine.buffer_not_sendable":
      return "Messages can't be sent to this conversation.";
    case "engine.channel_recreated":
      return "This channel was recreated while you were away. Verify its topic and members before trusting it.";
    case "engine.channel_required":
      return "That command only works in a channel.";
    case "engine.command_refused":
      return "The server refused that command.";
    case "engine.connection_failed":
      return "Couldn't connect to the server. Check the address, certificate, and whether this site is allowed.";
    case "engine.hosted_auth_failed":
      return "Your session expired. Signing in again.";
    case "engine.dedicated_worker_fallback":
      return "This browser uses one connection per tab because SharedWorker is unavailable.";
    case "engine.direct_target_gone":
      return "That person left or the nickname now belongs to someone else. Your message was not sent.";
    case "engine.direct_monitor_full":
      return "Too many open conversations to verify this person. Close one to message them.";
    case "engine.direct_presence_unavailable":
      return "Presence updates are unavailable for this conversation.";
    case "engine.direct_unavailable":
      return "That person isn't available for a private message.";
    case "engine.invalid_endpoint":
      return "That server address isn't valid.";
    case "engine.network_already_connected":
      return "That network is already connected.";
    case "engine.network_not_found":
      return "That network is no longer available.";
    case "engine.offline":
      return "That command needs a connection.";
    case "engine.send_failed":
      return "The message couldn't be sent.";
    case "engine.state_inconsistent":
      return "The conversation changed unexpectedly. Try again.";
    case "engine.unsupported_conversation":
      return "That conversation isn't supported.";
    case "engine.worker_failed":
    case "engine.command_failed":
      return "Something went wrong. Try again.";
    case "notice.message_not_delivered":
      return `Message to ${values.target ?? "that person"} wasn't delivered`;
    case "action.open":
      return "Open";
    case "mobile.preview.own":
      return `You: ${values.text ?? ""}`;
    default:
      return "Something went wrong. Try again.";
  }
}

function commandFrom(input: string | undefined): string {
  return input?.trim().split(/\s/u, 1)[0] || "that command";
}

function joinTargetFrom(input: string | undefined): string {
  return input?.trim().split(/\s+/u, 3)[1]?.split(",", 1)[0] || "that channel";
}
