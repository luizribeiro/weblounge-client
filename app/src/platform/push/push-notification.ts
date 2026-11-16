import { decodeBase64Url } from "./base64url";
import type {
  MeasurePushParserStage,
  PushParserLoader,
  PushPayloadParser,
} from "./push-parser-loader";

export interface PushNotificationRoute {
  readonly networkLabel: string;
  readonly nickname: string;
  readonly privateKeyPkcs8: Uint8Array<ArrayBuffer>;
  readonly auth: string;
}

export interface NotificationPresentation {
  readonly title: string;
  readonly options: NotificationOptions;
  readonly receiptId?: string;
  readonly receiptSequence?: number;
  readonly fallbackId?: string;
}

export interface PushedMessage {
  readonly schema: 1;
  readonly network_label: string;
  readonly nickname: string;
  readonly route: string;
  readonly sender: string;
  readonly account: string | null;
  readonly target: string;
  readonly msgid: string;
  readonly time: string;
  readonly text: string;
  readonly kind: "message" | "notice" | "action";
}

export type PreparedPush =
  | {
      readonly kind: "visible";
      readonly presentation: NotificationPresentation;
      readonly pushed: PushedMessage | undefined;
      readonly countedBody: (body: string, count: number) => string;
    }
  | { readonly kind: "markread"; readonly tag: string; readonly until: string }
  | { readonly kind: "ping" }
  | {
      readonly kind: "generic";
      readonly presentation: NotificationPresentation;
    };

export class PushDecryptError extends Error {}

export async function preparePushNotification(
  route: PushNotificationRoute,
  ciphertext: Uint8Array<ArrayBuffer>,
  loader: PushParserLoader,
  reportError: (error: unknown) => void = () => undefined,
  measure: MeasurePushParserStage = async (_stage, work) => work(),
): Promise<PreparedPush> {
  let parser: PushPayloadParser;
  try {
    parser = await loader.load(measure);
  } catch (error: unknown) {
    reportError(error);
    return genericPush(route.networkLabel);
  }
  const outcome = await measure("decrypt", () =>
    decryptedOutcome(
      parser.prepare_notification(
        ciphertext,
        route.privateKeyPkcs8,
        decodeBase64Url(route.auth),
        route.networkLabel,
        route.nickname,
      ),
    ),
  );
  try {
    return await measure("parse", () => preparedPush(outcome, parser));
  } catch (error: unknown) {
    reportError(error);
    return genericPush(route.networkLabel);
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

function genericPush(networkLabel: string): PreparedPush {
  return { kind: "generic", presentation: genericNotification(networkLabel) };
}

function decryptedOutcome(json: string): object {
  const outcome = parsedJson(json);
  if (typeof outcome !== "object" || outcome === null) return {};
  if (
    "outcome" in outcome &&
    outcome.outcome === "failed" &&
    "stage" in outcome &&
    outcome.stage === "decrypt"
  ) {
    throw new PushDecryptError(
      "message" in outcome ? String(outcome.message) : "decrypt failed",
    );
  }
  return outcome;
}

function preparedPush(
  outcome: object,
  parser: PushPayloadParser,
): PreparedPush {
  if (
    !("outcome" in outcome) ||
    outcome.outcome !== "prepared" ||
    !("notification" in outcome) ||
    typeof outcome.notification !== "object" ||
    outcome.notification === null ||
    !("kind" in outcome.notification)
  ) {
    throw new Error(
      "message" in outcome ? String(outcome.message) : "invalid prepared push",
    );
  }
  const notification = outcome.notification;
  if (notification.kind === "ping") return { kind: "ping" };
  if (
    notification.kind === "markread" &&
    "tag" in notification &&
    typeof notification.tag === "string" &&
    "until" in notification &&
    typeof notification.until === "string"
  ) {
    return {
      kind: "markread",
      tag: notification.tag,
      until: notification.until,
    };
  }
  if (
    notification.kind === "visible" &&
    "title" in notification &&
    typeof notification.title === "string" &&
    "body" in notification &&
    typeof notification.body === "string" &&
    "threadId" in notification &&
    typeof notification.threadId === "string" &&
    "userInfo" in notification &&
    typeof notification.userInfo === "object" &&
    notification.userInfo !== null &&
    "pushed" in notification
  ) {
    return {
      kind: "visible",
      presentation: {
        title: notification.title,
        options: {
          body: notification.body,
          tag: notification.threadId,
          data: notification.userInfo,
        },
      },
      pushed: pushedMessage(notification.pushed),
      countedBody: (body, count) =>
        parser.counted_notification_body(body, count, __PUSH_NEW_MESSAGES__),
    };
  }
  throw new Error("invalid prepared push");
}

function parsedJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function pushedMessage(value: unknown): PushedMessage | undefined {
  if (value === null) return undefined;
  if (
    typeof value === "object" &&
    "schema" in value &&
    value.schema === 1 &&
    "kind" in value &&
    ["message", "notice", "action"].includes(String(value.kind)) &&
    "account" in value &&
    (value.account === null || typeof value.account === "string") &&
    pushedTextFields.every(
      (field) =>
        field in value && typeof Reflect.get(value, field) === "string",
    )
  ) {
    return value as PushedMessage;
  }
  throw new Error("invalid pushed message");
}

const pushedTextFields = [
  "network_label",
  "nickname",
  "route",
  "sender",
  "target",
  "msgid",
  "time",
  "text",
] as const;
