import type { NotificationPresentation } from "../push/push-notification";

export interface ChatNotificationMessage {
  readonly networkLabel: string;
  readonly buffer: string;
  readonly direct: boolean;
  readonly sender: string;
  readonly action: boolean;
  readonly text: string;
  readonly msgid: string;
  readonly time: string;
}

export function chatNotification(
  message: ChatNotificationMessage,
): NotificationPresentation {
  const tag = conversationTag(message.networkLabel, message.buffer);
  return {
    title: message.direct
      ? message.sender
      : `${message.sender} in ${message.buffer}`,
    options: {
      body: message.action
        ? `* ${message.sender} ${message.text}`
        : message.text,
      tag,
      data: {
        route: bufferPath(message.networkLabel, message.buffer, message.direct),
        conversationTag: tag,
        messageId: message.msgid,
        messageTime: message.time,
      },
    },
  };
}

export function withNotificationCount(
  presentation: NotificationPresentation,
  count: number,
): NotificationPresentation {
  const body = presentation.options.body;
  if (count <= 1 || body === undefined) return presentation;
  const suffix = __PUSH_NEW_MESSAGES__.replace("{count}", String(count));
  return {
    ...presentation,
    options: { ...presentation.options, body: `${body}\n${suffix}` },
  };
}

export function conversationTag(networkLabel: string, buffer: string): string {
  return `${networkLabel}/${buffer.toLowerCase()}`;
}

export function bufferPath(
  network: string,
  buffer: string,
  direct: boolean,
): string {
  const destination = direct
    ? `@${encodeURIComponent(buffer)}`
    : encodeURIComponent(buffer.startsWith("#") ? buffer.slice(1) : buffer);
  return `/${encodeURIComponent(network)}/${destination}`;
}
