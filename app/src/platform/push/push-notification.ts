import type { PushParserLoader } from "./push-parser-loader";

export interface PushNotificationRoute {
  readonly networkId: number;
  readonly networkLabel: string;
  readonly nickname: string;
}

export type ParsedPushEvent =
  | ({ readonly type: "message" | "notice" | "action" } & ChatPayload)
  | {
      readonly type: "invite";
      readonly sender: string;
      readonly target: string;
    }
  | {
      readonly type: "markread";
      readonly target: string;
      readonly until: string;
    }
  | { readonly type: "ping" };

export interface ChatPayload {
  readonly sender: string;
  readonly target: string;
  readonly msgid: string;
  readonly time: string;
  readonly text: string;
}

export interface NotificationPresentation {
  readonly title: string;
  readonly options: NotificationOptions;
}

export interface ParsedNotification {
  readonly presentation: NotificationPresentation;
  readonly event?: ParsedPushEvent;
}

export async function notificationForLine(
  route: PushNotificationRoute,
  line: string,
  parser: PushParserLoader,
): Promise<ParsedNotification> {
  try {
    const event = decodeParsedEvent(JSON.parse(await parser.parse(line)));
    return { presentation: notificationFor(route, event), event };
  } catch {
    return { presentation: genericNotification(route.networkLabel) };
  }
}

export function genericNotification(
  networkLabel?: string,
): NotificationPresentation {
  return {
    title: "New message",
    options: {
      ...(networkLabel === undefined ? {} : { body: networkLabel }),
      data: { route: "/" },
    },
  };
}

export function isChatPayload(
  event: ParsedPushEvent,
): event is Extract<
  ParsedPushEvent,
  { type: "message" | "notice" | "action" }
> {
  return ["message", "notice", "action"].includes(event.type);
}

function notificationFor(
  route: PushNotificationRoute,
  event: ParsedPushEvent,
): NotificationPresentation {
  if (isChatPayload(event)) {
    const direct = sameIrcName(event.target, route.nickname);
    const buffer = direct ? event.sender : event.target;
    const bufferRoute = bufferPath(route.networkLabel, buffer, direct);
    return {
      title: direct ? event.sender : `${event.sender} in ${event.target}`,
      options: {
        body:
          event.type === "action"
            ? `* ${event.sender} ${event.text}`
            : event.text,
        tag: `${route.networkId}/${buffer.toLowerCase()}`,
        data: { route: bufferRoute },
      },
    };
  }
  if (event.type === "invite") {
    const bufferRoute = bufferPath(route.networkLabel, event.target, false);
    return {
      title: event.sender,
      options: {
        body: `Invited you to ${event.target}`,
        tag: `${route.networkId}/${event.target.toLowerCase()}`,
        data: { route: bufferRoute },
      },
    };
  }
  return genericNotification(route.networkLabel);
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

export function sameIrcName(first: string, second: string): boolean {
  return first.localeCompare(second, "en", { sensitivity: "base" }) === 0;
}

function decodeParsedEvent(value: unknown): ParsedPushEvent {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    throw new Error("invalid parsed push event");
  }
  if (value.type === "ping") return { type: "ping" };
  if (
    value.type === "markread" &&
    "target" in value &&
    typeof value.target === "string" &&
    "until" in value &&
    typeof value.until === "string"
  ) {
    return { type: value.type, target: value.target, until: value.until };
  }
  if (
    value.type === "invite" &&
    "sender" in value &&
    typeof value.sender === "string" &&
    "target" in value &&
    typeof value.target === "string"
  ) {
    return { type: value.type, sender: value.sender, target: value.target };
  }
  if (
    ["message", "notice", "action"].includes(String(value.type)) &&
    "sender" in value &&
    typeof value.sender === "string" &&
    "target" in value &&
    typeof value.target === "string" &&
    "msgid" in value &&
    typeof value.msgid === "string" &&
    "time" in value &&
    typeof value.time === "string" &&
    "text" in value &&
    typeof value.text === "string"
  ) {
    return value as ParsedPushEvent;
  }
  throw new Error("invalid parsed push event");
}
