export const messages = {
  "action.open": "Open",
  "action.add_network": "Add network",
  "action.debug": "Debug diagnostics",
  "action.jump_bottom": "Jump to latest message",
  "action.jump_buffer": "Jump to conversation {slot}",
  "action.list_next": "Next item",
  "action.list_open": "Open item",
  "action.list_previous": "Previous item",
  "action.mark_read": "Mark as read",
  "action.mark_read.description": "Mark the current conversation as read",
  "action.members_toggle": "Toggle member list",
  "action.network_server": "Open server messages",
  "action.next_buffer": "Next buffer",
  "action.open_buffer": "Join a channel or start a direct message",
  "action.open_direct": "Open direct message",
  "action.palette": "Command palette",
  "action.previous_buffer": "Previous buffer",
  "action.settings": "Settings",
  "action.show_buffer": "Show buffer",
  "action.sidebar_toggle": "Toggle channel list",
  "action.switcher": "Jump to",
  "common.away": "Away",
  "common.bot": "BOT",
  "common.bot_icon": "bot",
  "common.cancel": "Cancel",
  "common.channel": "Channel",
  "common.send": "Send",
  "common.retry": "Retry",
  "common.sign_in_again": "Sign in again",
  "common.weblounge": "weblounge",
  "cmd.close.confirmation_action": "Leave",
  "cmd.close.confirmation_prompt": "Leave {text}?",
  "cmd.close.description": "Close conversation",
  "cmd.close.menu": "Close conversation",
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
  "cmd.part.menu": "Leave channel",
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
  "cmd.topic.menu": "Edit topic…",
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
  "upload.label": "Image · {size}",
  "upload.remove": "Remove image",
  "upload.uploading": "Uploading image",
  "upload.uploaded": "Image uploaded",
  "upload.unavailable": "This network doesn’t accept uploads.",
  "upload.replace": "Replace the image being uploaded?",
  "upload.replace_action": "Replace",
  "upload.approval_label": "Allow upload to {host}",
  "upload.approval_title": "Send your password to {host}?",
  "upload.approval_explanation":
    "This network’s file host isn’t the server you signed in to. It receives your account name and password with the image.",
  "upload.approval_action": "Upload",
  "upload.approval_remember": "Remember for this network",
  "upload.failed.offline": "You’re offline.",
  "upload.failed.unavailable": "This network doesn’t accept uploads.",
  "upload.failed.other_site": "This network’s upload host is on another site.",
  "upload.failed.declined": "Upload cancelled.",
  "upload.failed.unauthorized": "The file host refused your sign-in.",
  "upload.failed.too_large": "Image is too large.",
  "upload.failed.too_large_limit": "Image is too large (max {limit}).",
  "upload.failed.unsupported_type": "Can’t upload this kind of image.",
  "upload.failed.undecodable": "Can’t read this image.",
  "upload.failed.rate_limited": "Too many uploads. Try again later.",
  "upload.failed.quota_full": "Your upload space is full.",
  "upload.failed.generic": "Upload failed.",
  "upload.failed.detail": "Upload failed: {detail}",
  "upload.failed.command": "Send commands without an image.",
  "upload.failed.send": "Couldn’t send. Try again.",
  "typing.and": "and",
  "typing.are_typing": "are typing…",
  "typing.is_typing": "is typing…",
  "typing.several": "several people are typing…",
  "conversation.open_direct": "Open direct message with {nick}",
  "conversation.toggle_members": "Toggle member list",
  "conversation.toggle_sidebar": "Toggle channel list",
  "reaction.including_you": ", including you",
  "reaction.label_one": "{reaction}, 1 reaction{ownership}",
  "reaction.label_many": "{reaction}, {count} reactions{ownership}",
  "reaction.who_action": "reacted with {reaction}",
  "reaction.you": "you",
  "direct_identity.cannot_verify": "Can't verify this is the same {nick}",
  "direct_identity.changed": "This isn't the same {nick} — different account",
  "direct_identity.defer": "Not now",
  "direct_identity.trust": "Trust new identity",
  "debug.buffer": "Buffer",
  "debug.buffer_summary":
    "{title} ({kind}, {unread} unread, {mentions} mentions)",
  "debug.buffers": "Buffers",
  "debug.message": "Message",
  "debug.network": "{label}: {nickname} ({state})",
  "debug.networks": "Networks",
  "debug.view": "Temporary engine debug view",
  "debug.engine_ready": "Engine ready: {message}",
  "debug.wasm_round_trip": "wasm worker round trip complete",
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
  "hosted.config_invalid":
    "This deployment is misconfigured. Invalid /config.json: {message}",
  "hosted.config_redirect":
    'Invalid /config.json: "oauth.redirect_uri" must be {expected}',
  "hosted.oauth.code_expired":
    "The sign-in code expired. Please sign in again.",
  "hosted.oauth.denied": "Authorization was denied. Sign in again to continue.",
  "hosted.oauth.incomplete":
    "Sign-in could not be completed. Please try again.",
  "hosted.oauth.invalid_field": "The sign-in {field} is invalid.",
  "hosted.oauth.invalid_metadata":
    "The sign-in service returned invalid metadata.",
  "hosted.oauth.invalid_session":
    "The sign-in service returned an invalid session.",
  "hosted.oauth.issue_session":
    "The sign-in service couldn't issue a session. Please try again.",
  "hosted.oauth.origin_field":
    "The sign-in {field} must use the issuer's origin.",
  "hosted.oauth.pkce": "The sign-in service doesn't support secure PKCE.",
  "hosted.oauth.response_mismatch":
    "The sign-in response did not match this tab. Sign in again.",
  "hosted.oauth.timeout":
    "The sign-in service did not respond. Please try again.",
  "hosted.oauth.unreachable": "Couldn't reach the sign-in service.",
  "hosted.oauth.unreachable_status":
    "Couldn't reach the sign-in service ({status}).",
  "hosted.oauth.wrong_issuer": "The sign-in service reported the wrong issuer.",
  "hosted.oauth.https_field": "The sign-in {field} must use HTTPS.",
  "hosted.reset_app": "Reset app",
  "hosted.resetting": "Resetting weblounge…",
  "hosted.restoring": "Restoring the chat…",
  "hosted.session_expired": "Your session expired. Signing in again…",
  "hosted.start_failed": "Couldn't start the app.",
  "hosted.starting": "Starting engine…",
  "hosted.starting_weblounge": "Starting weblounge…",
  "hosted.unreachable": "Can't reach weblounge. Check your connection.",
  "mobile.preview.own": "You: {text}",
  "mobile.back_to_chats": "Back to chats",
  "mobile.back_to_chats_action": "Back to Chats",
  "mobile.action.close": "Close",
  "mobile.action.leave": "Leave",
  "mobile.action.read": "Read",
  "mobile.actions_for": "Actions for {title}",
  "mobile.chats": "Chats",
  "mobile.close_target": "Close {title}",
  "mobile.conversation.channel": "Channel",
  "mobile.conversation.direct": "Direct message",
  "mobile.conversation.server": "Server",
  "mobile.empty": "No chats match this view.",
  "mobile.details_for": "Details for {title}",
  "mobile.filter.all": "All",
  "mobile.filter.channels": "Channels",
  "mobile.filter.direct": "Direct",
  "mobile.filter.label": "Chat filters",
  "mobile.filter.unread": "Unread",
  "mobile.leave_target": "Leave {title}",
  "mobile.preview.action": "* {author} {text}",
  "mobile.preview.direct_action": "* {text}",
  "mobile.preview.message": "{author}: {text}",
  "mobile.search": "Search chats",
  "mobile.search_placeholder": "Search channels and people",
  "mobile.show_details": "Show details for {title}",
  "mobile.show_members": "Show members",
  "messages.date.today": "Today",
  "messages.date.yesterday": "Yesterday",
  "messages.delivery.failed": "Failed",
  "messages.delivery.failed_retry": "Failed · Retry",
  "messages.delivery.sending": "Sending…",
  "messages.empty.channel": "Messages sent in {target} will appear here.",
  "messages.empty.direct": "Messages you and {target} send will appear here.",
  "messages.empty.title": "No messages yet",
  "messages.gap": "Messages may be missing · {from} to {to}",
  "messages.jump.many": "{count} new messages ↓",
  "messages.jump.one": "{count} new message ↓",
  "messages.history.caption": "Server history starts {date}",
  "messages.history.channel": "Beginning of {target}",
  "messages.history.direct": "Beginning of your messages with {target}",
  "messages.history.loading": "Loading older messages…",
  "messages.history.start": "Start of history",
  "messages.image.failed": "Couldn’t load image",
  "messages.image.open": "Open image from {nick} on {host}",
  "messages.image.open_link": "Open link",
  "messages.image.view": "Image from {nick}, open viewer",
  "image_viewer.close": "Close image",
  "image_viewer.label": "Image from {nick}",
  "image_viewer.open_original": "Open original",
  "image_viewer.status": "Image from {nick}. Press Escape to close.",
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
  "members.filter": "Filter members",
  "members.group.away": "Away",
  "members.group.bots": "Bots",
  "members.group.online": "Online",
  "members.group.operators": "Operators",
  "members.group.voiced": "Voiced",
  "members.hide": "Hide members",
  "members.label": "Members",
  "members.label_for": "Members of {channel}",
  "members.you": "you",
  "notifications.dismiss": "Dismiss notification prompt",
  "notifications.label": "Notifications",
  "notifications.prompt": "Get notified about DMs and mentions",
  "notifications.turn_on": "Turn on",
  "notifications.new_message": "New message",
  "notifications.new_messages": "· {count} new messages",
  "notice.message_not_delivered": "Message to {target} wasn't delivered",
  "settings.appearance": "Appearance",
  "settings.close": "Close settings",
  "settings.conversation": "Conversation",
  "settings.density.comfortable": "Comfortable",
  "settings.density.compact": "Compact",
  "settings.density.cozy": "Cozy",
  "settings.message_density": "Message density",
  "settings.message_density.description":
    "Spacing, text size and avatar size in the conversation.",
  "settings.sections": "Settings sections",
  "settings.theme": "Theme",
  "settings.theme.system": "System",
  "settings.theme.system_description": "Lounge, or Lounge Night after dark",
  "sidebar.channel_list": "Channel list",
  "sidebar.context_menu": "Actions for {title}",
  "sidebar.close_conversation": "Close conversation with {title}",
  "sidebar.closed_conversation": "Closed chat with {title}",
  "sidebar.leave_explanation":
    "You’ll stop receiving messages until you rejoin.",
  "sidebar.undo": "Undo",
  "sidebar.navigation": "Networks and buffers",
  "sidebar.network.many": "{count} networks",
  "sidebar.network.one": "{count} network",
  "sidebar.network_state.connecting": "connecting",
  "sidebar.network_state.failed": "failed",
  "sidebar.network_state.offline": "offline",
  "sidebar.network_state.online": "online",
  "sidebar.network_state.reconnecting": "reconnecting",
  "sidebar.network_state.registering": "registering",
  "sidebar.network_label": "{network}, {state}",
  "sidebar.row_label": "{title}, {badge}",
  "sidebar.unread": "{count} unread",
  "sidebar.unread_mentions": "{count} unread, including mentions",
  "palette.close": "Close command palette",
  "palette.dialog": "Command palette",
  "palette.empty": "No matching commands.",
  "palette.input": "Run a command",
  "palette.placeholder": "Type a command",
  "palette.results": "Commands",
  "switcher.dialog": "Quick switcher",
  "switcher.close": "Close quick switcher",
  "switcher.empty": "No matching conversations.",
  "switcher.escape": "esc",
  "switcher.input": "Jump to",
  "switcher.placeholder": "Jump to a channel or person",
  "switcher.results": "Conversations",
  "shell.connect_to_begin": "Connect to a network to begin.",
  "shell.conversation_unavailable": "This conversation is not available.",
  "shell.connection_failed": "Couldn't connect",
  "shell.session_expired": "Session expired",
  "shell.engine_start_failed": "Engine failed to start",
  "shell.engine_timeout": "the chat engine did not respond in time",
  "shell.unexpected_failure": "Something went wrong.",
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
