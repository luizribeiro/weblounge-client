import { describe, expect, it, vi } from "vitest";
import {
  schedulePushPresentation,
  showOnce,
} from "./platform/push/push-delivery-state";
import {
  deadlineFallbackNotification,
  genericNotification,
  notificationForLine,
  type ParsedPushEvent,
} from "./platform/push/push-notification";
import {
  notificationDataIsRead,
  recordPresentedNotification,
} from "./platform/push/push-notification-state";
import {
  PushParserLoader,
  type PushPayloadParser,
} from "./platform/push/push-parser-loader";

it("retries loading the push parser after a cached failure", async () => {
  const parser: PushPayloadParser = {
    parse_push_payload_json: (line) => JSON.stringify({ type: line }),
  };
  const load = vi
    .fn<() => Promise<PushPayloadParser>>()
    .mockRejectedValueOnce(new Error("parser cache is unavailable"))
    .mockResolvedValue(parser);
  const loader = new PushParserLoader(load);

  await expect(loader.parse("first")).rejects.toThrow(
    "parser cache is unavailable",
  );
  await expect(loader.parse("second")).resolves.toBe(
    JSON.stringify({ type: "second" }),
  );
  expect(load).toHaveBeenCalledTimes(2);
});

describe("push delivery state", () => {
  it("keeps a successful presentation live while persistence crosses its deadline", async () => {
    vi.useFakeTimers();
    try {
      const present = vi.fn(async (_value: string) => undefined);
      const state = schedulePushPresentation<string>(
        "generic",
        (generic) => generic,
        present,
        1_500,
        2_000,
        () => undefined,
      );

      await showOnce(state, "detailed");
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(state.fallback).resolves.toBeUndefined();

      expect(state.expired).toBe(false);
      expect(state.shown).toBe(true);
      expect(present).toHaveBeenCalledExactlyOnceWith("detailed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a newer same-tag notification supersede an older read marker", () => {
    const tag = "Lounge/#lounge";
    const time = "2026-11-03T12:34:56.789Z";
    const counts = {
      conversations: new Map([
        [tag, { unknown: 0, messages: new Map<string, number>() }],
      ]),
      readAtMs: new Map([[tag, Date.parse(time)]]),
      untagged: 0,
    };
    const data = { conversationTag: tag, messageTime: time };
    expect(notificationDataIsRead(data, counts.readAtMs)).toBe(true);

    recordPresentedNotification(counts, {
      tag,
      messageId: "new-message",
      messageTime: "2026-11-03T12:34:56.790Z",
    });

    expect(counts.conversations.get(tag)?.messages.size).toBe(1);
    expect(notificationDataIsRead(data, counts.readAtMs)).toBe(false);
    counts.readAtMs.set(tag, Date.parse(time));
    expect(notificationDataIsRead(data, counts.readAtMs)).toBe(true);
  });
});

const route = {
  networkId: 1,
  networkLabel: "Lounge",
  nickname: "weblounge",
};
const time = "2026-11-03T12:34:56.789Z";

describe("push worker notification presentation", () => {
  it.each([
    {
      name: "account-tagged PRIVMSG",
      line: `@account=mel;time=${time};msgid=priv :mel!m@example.test PRIVMSG #lounge :hello there`,
      event: chat("message", "mel", "#lounge", "priv", "hello there", "mel"),
      title: "mel in #lounge",
      body: "hello there",
      tag: "Lounge/#lounge",
      destination: "/Lounge/lounge",
    },
    {
      name: "NOTICE",
      line: `@time=${time};msgid=notice :NickServ!s@example.test NOTICE weblounge :identify first`,
      event: chat(
        "notice",
        "NickServ",
        "weblounge",
        "notice",
        "identify first",
      ),
      title: "NickServ",
      body: "identify first",
      tag: "Lounge/nickserv",
      destination: "/Lounge/@NickServ",
    },
    {
      name: "ACTION",
      line: `@time=${time};msgid=action :mel!m@example.test PRIVMSG #lounge :\u0001ACTION waves\u0001`,
      event: chat("action", "mel", "#lounge", "action", "waves"),
      title: "mel in #lounge",
      body: "* mel waves",
      tag: "Lounge/#lounge",
      destination: "/Lounge/lounge",
    },
    {
      name: "emoji PRIVMSG",
      line: `@account=mel;time=${time};msgid=emoji :mel!m@example.test PRIVMSG #lounge :ship it 🚀`,
      event: chat("message", "mel", "#lounge", "emoji", "ship it 🚀", "mel"),
      title: "mel in #lounge",
      body: "ship it 🚀",
      tag: "Lounge/#lounge",
      destination: "/Lounge/lounge",
    },
  ])("shows a real notification for $name", async (fixture) => {
    const result = await notificationForLine(
      route,
      fixture.line,
      parserReturning(fixture.line, fixture.event),
    );

    expect(result.presentation).toEqual({
      title: fixture.title,
      options: {
        body: fixture.body,
        tag: fixture.tag,
        data: {
          route: fixture.destination,
          conversationTag: fixture.tag,
          messageId: fixture.event.msgid,
          messageTime: fixture.event.time,
        },
      },
    });
    expect(result.event).toEqual(fixture.event);
  });

  it.each([
    {
      name: "CTCP VERSION",
      line: `@time=${time};msgid=version :mel!m@example.test PRIVMSG weblounge :\u0001VERSION\u0001`,
      event: new Error("unsupported IRC push command"),
    },
    {
      name: "MARKREAD",
      line: `:irc.example.test MARKREAD #lounge timestamp=${time}`,
      event: {
        type: "markread" as const,
        target: "#lounge",
        until: `timestamp=${time}`,
      },
    },
    {
      name: "PING",
      line: "PING :push-registration",
      event: { type: "ping" as const },
    },
  ])("uses the generic notification for $name", async (fixture) => {
    const result = await notificationForLine(
      route,
      fixture.line,
      parserReturning(fixture.line, fixture.event),
    );

    expect(result.presentation).toEqual(genericNotification("Lounge"));
  });

  it("uses a generic notification without a body for an unknown route", () => {
    expect(genericNotification()).toEqual({
      title: "New message",
      options: { data: { route: "/" } },
    });
  });

  it("marks only a deadline fallback for later replacement", () => {
    expect(genericNotification(undefined, "receipt")).toEqual({
      title: "New message",
      options: { data: { route: "/", receiptId: "receipt" } },
      receiptId: "receipt",
    });
    expect(
      deadlineFallbackNotification(
        genericNotification("Lounge", "receipt"),
        "receipt",
      ),
    ).toEqual({
      title: "New message",
      options: {
        body: "Lounge",
        data: {
          route: "/",
          receiptId: "receipt",
          fallbackId: "receipt",
        },
      },
      receiptId: "receipt",
      fallbackId: "receipt",
    });
  });
});

function chat(
  type: "message" | "notice" | "action",
  sender: string,
  target: string,
  msgid: string,
  text: string,
  account: string | null = null,
): Extract<ParsedPushEvent, { type: "message" | "notice" | "action" }> {
  return { type, sender, account, target, msgid, time, text };
}

function parserReturning(
  expectedLine: string,
  event: ParsedPushEvent | Error,
): PushParserLoader {
  return new PushParserLoader(async () => ({
    parse_push_payload_json: (line) => {
      expect(line).toBe(expectedLine);
      if (event instanceof Error) throw event;
      return JSON.stringify(event);
    },
  }));
}
