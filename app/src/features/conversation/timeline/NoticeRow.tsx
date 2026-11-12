import { t } from "../../../strings";
import { formatTime } from "../../../ui/format-time";
import { EventIcon } from "../../../ui/icons/EventIcon";
import { Selectable } from "../../../ui/Selectable";
import { MessageText, Nickname } from "../MessageText";
import type { NickDisplay } from "../nick-lookup";
import styles from "./NoticeRow.module.css";
import type { IrcNoticeMessage } from "./notice-message";

export function NoticeRow(props: {
  readonly message: IrcNoticeMessage;
  readonly nickLookup: ReadonlyMap<string, NickDisplay>;
  readonly onOpenChannel?: ((channel: string) => void) | undefined;
  readonly onOpenDirect?: ((nick: string) => void) | undefined;
  readonly onOpenExternal?: ((href: string) => void) | undefined;
  readonly presentation: "desktop" | "mobile";
}) {
  const source = props.message.kind.irc_notice;
  const server = source === "server";
  const time = props.message.server_time_ms ?? props.message.received_at_ms;
  const label = server ? "Server notice" : "Notice";
  const icon = server ? "server" : "notice";
  const sender = (
    <>
      <Nickname
        class={`${styles.sender} ${server ? styles.server : ""}`}
        display={server ? undefined : props.message}
        onOpenDirect={server ? undefined : props.onOpenDirect}
        title={props.message.author}
        value={props.message.author}
      />
      {props.message.unverified_sender === true && (
        <span
          aria-label={t("messages.unverified_sender")}
          class={styles.unverified}
          role="img"
        >
          ?
        </span>
      )}
    </>
  );
  const text = (
    <MessageText
      authors={props.nickLookup}
      onOpenChannel={props.onOpenChannel}
      onOpenDirect={props.onOpenDirect}
      onOpenExternal={props.onOpenExternal}
      text={props.message.text}
    />
  );
  return (
    <div
      class={`${styles.row} ${props.message.highlighted ? styles.highlighted : ""}`}
      data-irc-notice="true"
      data-message-row="true"
      data-message-text={props.message.text}
      data-notice-source={source}
      data-presentation={props.presentation}
      data-unverified-sender={props.message.unverified_sender || undefined}
    >
      {props.presentation === "mobile" ? (
        <>
          <EventIcon class={styles.icon} icon={icon} label={label} />
          <Selectable
            class={styles.mobileText}
            surfaceId={`message-${props.message.id}`}
          >
            {sender}
            <span class={styles.gap}> </span>
            {text}
            <span class={styles.gap}> </span>
            <time
              class={styles.mobileTime}
              dateTime={new Date(time).toISOString()}
            >
              {formatTime(time)}
            </time>
          </Selectable>
        </>
      ) : (
        <>
          <time class={styles.time} dateTime={new Date(time).toISOString()}>
            {formatTime(time)}
          </time>
          <div class={styles.identity}>
            <EventIcon class={styles.icon} icon={icon} label={label} />
            {sender}
          </div>
          <Selectable
            class={styles.text}
            surfaceId={`message-${props.message.id}`}
          >
            {text}
          </Selectable>
        </>
      )}
    </div>
  );
}
