import type {
  BufferProjection,
  MessageProjection,
} from "../../engine/protocol";
import { supportsPageNotifications } from "../../features/notifications/notification-prompt-visibility";
import type { ChatNotificationMessage } from "../push/push-notification";
import {
  type PushDelivery,
  shouldPostPageNotification,
} from "./page-notification-policy";
import { type CreatePageNotification, PageNotifier } from "./page-notifier";
import { PostingTabLock, type PostingTabLocks } from "./posting-tab-lock";

export interface NotifiableMessage {
  readonly buffer: BufferProjection;
  readonly message: MessageProjection;
}

export interface PageNotificationContext {
  networkLabel(networkId: number): string | undefined;
  pushDelivery(networkId: number): PushDelivery;
  pageForeground(): boolean;
  shownBufferIds(): ReadonlySet<number>;
  openRoute(route: string): void;
}

export interface PageNotificationApi {
  permission(): NotificationPermission;
  readonly create: CreatePageNotification;
}

export interface PageNotificationPlatform {
  readonly notifications: PageNotificationApi | undefined;
  readonly locks: PostingTabLocks | null | undefined;
}

const postingTabLockName = "weblounge-page-notifications";

export class PageNotifications {
  readonly #context: PageNotificationContext;
  readonly #api: PageNotificationApi | undefined;
  readonly #notifier: PageNotifier | undefined;
  readonly #postingTab: PostingTabLock;

  constructor(
    context: PageNotificationContext,
    platform: PageNotificationPlatform = browserPlatform(),
  ) {
    this.#context = context;
    this.#api = platform.notifications;
    this.#notifier =
      platform.notifications === undefined
        ? undefined
        : new PageNotifier(platform.notifications.create, (route) =>
            context.openRoute(route),
          );
    this.#postingTab = new PostingTabLock(postingTabLockName, platform.locks);
  }

  handle({ buffer, message }: NotifiableMessage): void {
    const networkLabel = this.#context.networkLabel(buffer.network_id);
    if (networkLabel === undefined || !this.#shouldPost(buffer)) return;
    this.#notifier?.post(
      chatNotificationMessage(networkLabel, buffer, message),
      buffer.mentions,
    );
  }

  claimPosting(): void {
    this.#postingTab.claim();
  }

  closeRead(readMarkers: ReadonlyMap<string, number>): void {
    this.#notifier?.closeRead(readMarkers);
  }

  dispose(): void {
    this.#postingTab.dispose();
  }

  #shouldPost(buffer: BufferProjection): boolean {
    return shouldPostPageNotification({
      pageNotificationsSupported: this.#api !== undefined,
      permission: this.#api?.permission() ?? "default",
      pushDelivery: this.#context.pushDelivery(buffer.network_id),
      postingTab: this.#postingTab.held,
      pageForeground: this.#context.pageForeground(),
      bufferShown: this.#context.shownBufferIds().has(buffer.id),
    });
  }
}

export function chatNotificationMessage(
  networkLabel: string,
  buffer: BufferProjection,
  message: MessageProjection,
): ChatNotificationMessage {
  return {
    networkLabel,
    buffer: buffer.title,
    direct: buffer.kind === "direct",
    sender: message.author,
    action: message.kind === "action",
    text: message.text,
    msgid: message.server_ids[0] ?? `local:${message.id}`,
    time: new Date(
      message.server_time_ms ?? message.received_at_ms,
    ).toISOString(),
  };
}

function browserPlatform(): PageNotificationPlatform {
  return {
    notifications: supportsPageNotifications(window)
      ? {
          permission: () => Notification.permission,
          create: (title, options) => new Notification(title, options),
        }
      : undefined,
    locks: navigator.locks,
  };
}
