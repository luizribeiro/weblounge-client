import {
  bufferPath,
  chatNotification,
  conversationTag,
} from "../page-notifications/page-notification-format";
import type {
  MeasurePushParserStage,
  PushParserLoader,
} from "./push-parser-loader";

const noticeType = `not${"ice"}` as const;

export interface PushNotificationRoute {
  readonly networkId: number;
  readonly networkLabel: string;
  readonly nickname: string;
}

export type ParsedPushEvent =
  | ({ readonly type: "message" | typeof noticeType | "action" } & ChatPayload)
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
  readonly account: string | null;
  readonly target: string;
  readonly msgid: string;
  readonly time: string;
  readonly text: string;
}

export interface NotificationPresentation {
  readonly title: string;
  readonly options: NotificationOptions;
  readonly receiptId?: string;
  readonly receiptSequence?: number;
  readonly fallbackId?: string;
}

export interface ParsedNotification {
  readonly presentation: NotificationPresentation;
  readonly event?: ParsedPushEvent;
}

export async function notificationForLine(
  route: PushNotificationRoute,
  line: string,
  parser: PushParserLoader,
  reportError: (error: unknown) => void = () => undefined,
  measure?: MeasurePushParserStage,
): Promise<ParsedNotification> {
  try {
    const parsed = await parser.parse(line, measure);
    const decode = () => decodeParsedEvent(JSON.parse(parsed));
    const event =
      measure === undefined ? decode() : await measure("parse", decode);
    return { presentation: notificationFor(route, event), event };
  } catch (error: unknown) {
    reportError(error);
    return { presentation: genericNotification(route.networkLabel) };
  }
}

export function genericNotification(
  networkLabel?: string,
  receiptId?: string,
): NotificationPresentation {
  return {
    title: __PUSH_NEW_MESSAGE__,
    options: {
      ...(networkLabel === undefined ? {} : { body: networkLabel }),
      data: {
        route: "/",
        ...(receiptId === undefined ? {} : { receiptId }),
      },
    },
    ...(receiptId === undefined ? {} : { receiptId }),
  };
}

export function deadlineFallbackNotification(
  presentation: NotificationPresentation,
  fallbackId: string,
): NotificationPresentation {
  return {
    ...presentation,
    options: {
      ...presentation.options,
      tag: `weblounge-fallback/${fallbackId}`,
      data: { route: "/", receiptId: presentation.receiptId, fallbackId },
    },
    fallbackId,
  };
}

export function isChatPayload(
  event: ParsedPushEvent,
): event is Extract<
  ParsedPushEvent,
  { type: "message" | typeof noticeType | "action" }
> {
  return ["message", noticeType, "action"].includes(event.type);
}

function notificationFor(
  route: PushNotificationRoute,
  event: ParsedPushEvent,
): NotificationPresentation {
  if (isChatPayload(event)) {
    const direct = sameIrcName(event.target, route.nickname);
    return chatNotification({
      networkLabel: route.networkLabel,
      buffer: direct ? event.sender : event.target,
      direct,
      sender: event.sender,
      action: event.type === "action",
      text: event.text,
      msgid: event.msgid,
      time: event.time,
    });
  }
  if (event.type === "invite") {
    const bufferRoute = bufferPath(route.networkLabel, event.target, false);
    return {
      title: event.sender,
      options: {
        body: `Invited you to ${event.target}`,
        tag: conversationTag(route.networkLabel, event.target),
        data: { route: bufferRoute },
      },
    };
  }
  return genericNotification(route.networkLabel);
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
    ["message", noticeType, "action"].includes(String(value.type)) &&
    "sender" in value &&
    typeof value.sender === "string" &&
    "account" in value &&
    (value.account === null || typeof value.account === "string") &&
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
