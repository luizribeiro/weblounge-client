import type { LineEvent } from "../../../engine/generated/LineEvent";
import { actorWords, button, mono, nick, text } from "./system-line-segments";
import type {
  SystemLineIcon,
  SystemLineSegment,
  SystemLineWordOptions,
  SystemLineWords,
} from "./system-line-word-types";

export function eventWords(
  event: LineEvent,
  options: SystemLineWordOptions,
): SystemLineWords {
  let segments: SystemLineSegment[];
  let icon: SystemLineIcon = "info";
  let warning = false;
  switch (event.type) {
    case "kick": {
      icon = "kick";
      warning = event.subject.type === "you";
      segments = [
        ...actorWords(event.actor),
        text(" kicked "),
        ...(event.subject.type === "you"
          ? [text("you")]
          : [nick(event.subject)]),
        ...(event.reason === null ? [] : [text(`: “${event.reason}”`)]),
      ];
      if (options.canRejoin === true)
        segments.push(
          text(" · "),
          button("rejoin", "Rejoin", "Rejoin channel"),
        );
      break;
    }
    case "topic":
      segments = [
        ...actorWords(event.actor),
        text(
          event.topic === null ? " cleared the topic" : " changed the topic",
        ),
        ...(event.topic === null ? [] : [text(": "), text(event.topic)]),
      ];
      break;
    case "topic_card":
      segments = [text("Topic: "), text(event.topic)];
      break;
    case "invited_you":
      icon = "invite";
      segments = [
        ...actorWords(event.actor),
        text(" invited you to "),
        mono(event.channel),
        text(" · "),
        button("join", "Join", `Join ${event.channel}`),
      ];
      break;
    case "renamed":
      segments = [
        mono(event.old),
        text(" is now "),
        mono(event.new),
        text(", renamed by "),
        ...actorWords(event.actor),
      ];
      break;
    case "connected":
      segments = [
        text("Connected to "),
        mono(event.server),
        text(event.secure ? " over TLS" : " without TLS"),
      ];
      break;
    case "motd":
      segments = [text("Message of the day")];
      break;
    case "reply":
      warning = event.severity === "fail";
      segments = [mono(event.code), text(` ${event.text}`)];
      break;
    case "raw":
      segments = [mono(event.line)];
      break;
    case "note":
      warning = event.tone === "error";
      segments = [text(event.key)];
      break;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
  return { details: [], icon: warning ? "warning" : icon, segments, warning };
}
