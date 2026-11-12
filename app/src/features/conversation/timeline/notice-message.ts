import type { NoticeKind } from "../../../engine/generated/NoticeKind";
import type { NoticeSource } from "../../../engine/generated/NoticeSource";
import type { MessageProjection } from "../../../engine/protocol";

export type IrcNoticeMessage = MessageProjection & {
  readonly kind: { readonly irc_notice: NoticeSource };
};

export type LocalNoticeMessage = MessageProjection & {
  readonly kind: { readonly notice: NoticeKind };
};

export function isIrcNoticeMessage(
  message: MessageProjection,
): message is IrcNoticeMessage {
  return typeof message.kind === "object" && "irc_notice" in message.kind;
}

export function isLocalNoticeMessage(
  message: MessageProjection,
): message is LocalNoticeMessage {
  return typeof message.kind === "object" && "notice" in message.kind;
}
