import type { MessageId } from "../engine/generated/MessageId";

/** Sends composer input to a conversation, threaded under `replyTo` when it answers a message. */
export type SendText = (
  bufferId: number,
  text: string,
  replyTo?: MessageId,
) => Promise<boolean>;
