interface MessageValues {
  readonly input?: string;
  readonly text?: string;
}

export const messageKeys = [
  "composer.empty_input",
  "composer.missing_argument",
  "composer.unknown_command",
  "engine.join_banned",
  "engine.buffer_not_sendable",
  "engine.channel_required",
  "engine.command_refused",
  "engine.dedicated_worker_fallback",
  "engine.direct_target_gone",
  "engine.direct_unavailable",
  "engine.invalid_endpoint",
  "engine.network_already_connected",
  "engine.network_not_found",
  "engine.send_failed",
  "engine.state_inconsistent",
  "engine.unsupported_conversation",
  "engine.worker_failed",
  "engine.command_failed",
] as const;

export function t(key: string, values: MessageValues = {}): string {
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
    case "engine.channel_required":
      return "That command only works in a channel.";
    case "engine.command_refused":
      return "The server refused that command.";
    case "engine.dedicated_worker_fallback":
      return "This browser uses one connection per tab because SharedWorker is unavailable.";
    case "engine.direct_target_gone":
      return "That person left or the nickname now belongs to someone else. Your message was not sent.";
    case "engine.direct_unavailable":
      return "That person isn't available for a private message.";
    case "engine.invalid_endpoint":
      return "That server address isn't valid.";
    case "engine.network_already_connected":
      return "That network is already connected.";
    case "engine.network_not_found":
      return "That network is no longer available.";
    case "engine.send_failed":
      return "The message couldn't be sent.";
    case "engine.state_inconsistent":
      return "The conversation changed unexpectedly. Try again.";
    case "engine.unsupported_conversation":
      return "That conversation isn't supported.";
    case "engine.worker_failed":
    case "engine.command_failed":
      return "Something went wrong. Try again.";
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
