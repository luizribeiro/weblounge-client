interface MessageValues {
  readonly input?: string;
}

export function t(key: string, values: MessageValues = {}): string {
  switch (key) {
    case "composer.empty_input":
      return "Enter a message or command.";
    case "composer.missing_argument":
      return "That command needs more information.";
    case "composer.unknown_command":
      return `Unknown command ${commandFrom(values.input)}`;
    case "engine.join_banned":
      return `Couldn't join ${joinTargetFrom(values.input)}: you're banned`;
    case "engine.buffer_not_sendable":
      return "Messages can't be sent to this conversation.";
    case "engine.channel_required":
      return "That command only works in a channel.";
    case "engine.command_refused":
      return "The server refused that command.";
    case "engine.dedicated_worker_fallback":
      return "This browser uses one connection per tab because SharedWorker is unavailable.";
    case "engine.direct_account_changed":
      return "The recipient's account changed before the message was sent.";
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
