import {
  bufferPath,
  type ChatNotificationMessage,
  chatNotification,
  conversationTag,
  withNotificationCount,
} from "../push/push-notification";
import { notificationDataIsRead } from "../push/push-notification-state";

export interface PageNotification {
  onclick: ((event: Event) => void) | null;
  close(): void;
}

export interface PageNotificationOptions {
  readonly body?: string;
  readonly tag?: string;
}

export type CreatePageNotification = (
  title: string,
  options: PageNotificationOptions,
) => PageNotification;

interface PostedNotification {
  readonly notification: PageNotification;
  readonly messageTime: string;
}

const rememberedMessageLimit = 512;

export class PageNotifier {
  readonly #create: CreatePageNotification;
  readonly #openRoute: (route: string) => void;
  readonly #postedMessageIds = new Set<string>();
  readonly #byConversation = new Map<string, PostedNotification>();

  constructor(
    create: CreatePageNotification,
    openRoute: (route: string) => void,
  ) {
    this.#create = create;
    this.#openRoute = openRoute;
  }

  post(message: ChatNotificationMessage, unreadCount: number): boolean {
    if (this.#postedMessageIds.has(message.msgid)) return false;
    this.#rememberMessage(message.msgid);
    const tag = conversationTag(message.networkLabel, message.buffer);
    const presentation = withNotificationCount(
      chatNotification(message),
      unreadCount,
    );
    this.#close(tag);
    const notification = this.#show(presentation.title, {
      ...(presentation.options.body === undefined
        ? {}
        : { body: presentation.options.body }),
      tag,
    });
    if (notification === undefined) return false;
    const route = bufferPath(
      message.networkLabel,
      message.buffer,
      message.direct,
    );
    notification.onclick = () => {
      this.#close(tag);
      this.#openRoute(route);
    };
    this.#byConversation.set(tag, {
      notification,
      messageTime: message.time,
    });
    return true;
  }

  closeRead(readMarkers: ReadonlyMap<string, number>): void {
    for (const [tag, posted] of this.#byConversation) {
      const identity = {
        conversationTag: tag,
        messageTime: posted.messageTime,
      };
      if (notificationDataIsRead(identity, readMarkers)) this.#close(tag);
    }
  }

  #show(
    title: string,
    options: PageNotificationOptions,
  ): PageNotification | undefined {
    try {
      return this.#create(title, options);
    } catch {
      // Chrome for Android only shows notifications through a service worker
      // and throws from the constructor: https://crbug.com/481856
      return undefined;
    }
  }

  #close(tag: string): void {
    this.#byConversation.get(tag)?.notification.close();
    this.#byConversation.delete(tag);
  }

  #rememberMessage(msgid: string): void {
    this.#postedMessageIds.add(msgid);
    if (this.#postedMessageIds.size <= rememberedMessageLimit) return;
    const oldest = this.#postedMessageIds.values().next().value;
    if (oldest !== undefined) this.#postedMessageIds.delete(oldest);
  }
}
