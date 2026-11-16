import { describe, expect, it, vi } from "vitest";
import {
  genericNotification,
  PushDecryptError,
  type PushNotificationRoute,
  preparePushNotification,
} from "./push-notification";
import {
  type MeasurePushParserStage,
  PushParserLoader,
  type PushPayloadParser,
} from "./push-parser-loader";

const time = "2026-11-03T12:34:56.789Z";
const route: PushNotificationRoute = {
  networkLabel: "Lounge",
  nickname: "weblounge",
  privateKeyPkcs8: new Uint8Array([48, 129, 135, 2, 1, 0]),
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
};
const ciphertext = new Uint8Array([12, 107, 250, 173]);
const pushed = {
  schema: 1,
  network_label: "Lounge",
  nickname: "weblounge",
  route: "/Lounge/lounge",
  sender: "mel",
  account: "mel",
  target: "#lounge",
  msgid: "priv",
  time,
  text: "hello there",
  kind: "message",
};
const visibleChat = {
  outcome: "prepared",
  notification: {
    kind: "visible",
    title: "mel in #lounge",
    body: "hello there",
    threadId: "Lounge/#lounge",
    userInfo: {
      route: "/Lounge/lounge",
      conversationTag: "Lounge/#lounge",
      messageId: "priv",
      messageTime: time,
    },
    pushed,
  },
};

describe("preparePushNotification", () => {
  it("hands the route's keys and identity to the shared preparer", async () => {
    const parser = fakeParser(visibleChat);

    await preparePushNotification(route, ciphertext, loaderFor(parser));

    expect(parser.prepare_notification).toHaveBeenCalledExactlyOnceWith(
      ciphertext,
      route.privateKeyPkcs8,
      new Uint8Array([
        5, 48, 89, 50, 161, 199, 234, 190, 19, 182, 206, 201, 253, 164, 136,
        130,
      ]),
      "Lounge",
      "weblounge",
    );
  });

  it("presents a prepared chat message and keeps its pushed record", async () => {
    const prepared = await preparePushNotification(
      route,
      ciphertext,
      loaderFor(fakeParser(visibleChat)),
    );

    expect(prepared).toMatchObject({
      kind: "visible",
      presentation: {
        title: "mel in #lounge",
        options: {
          body: "hello there",
          tag: "Lounge/#lounge",
          data: visibleChat.notification.userInfo,
        },
      },
      pushed,
    });
  });

  it("counts bodies through the shared formatter with the build's string", async () => {
    const parser = fakeParser(visibleChat);
    const prepared = await preparePushNotification(
      route,
      ciphertext,
      loaderFor(parser),
    );
    if (prepared.kind !== "visible") throw new Error("expected visible");

    expect(prepared.countedBody("latest from iris", 3)).toBe(
      "latest from iris (3)",
    );
    expect(parser.counted_notification_body).toHaveBeenCalledWith(
      "latest from iris",
      3,
      "· {count} new messages",
    );
  });

  it("presents an invite without a pushed record", async () => {
    const prepared = await preparePushNotification(
      route,
      ciphertext,
      loaderFor(
        fakeParser({
          outcome: "prepared",
          notification: {
            kind: "visible",
            title: "mel",
            body: "Invited you to #secret",
            threadId: "Lounge/#secret",
            userInfo: { route: "/Lounge/secret" },
            pushed: null,
          },
        }),
      ),
    );

    expect(prepared).toMatchObject({ kind: "visible", pushed: undefined });
  });

  it("turns markread and ping into silent controls", async () => {
    const markread = await preparePushNotification(
      route,
      ciphertext,
      loaderFor(
        fakeParser({
          outcome: "prepared",
          notification: {
            kind: "markread",
            tag: "Lounge/#lounge",
            until: `timestamp=${time}`,
          },
        }),
      ),
    );
    const ping = await preparePushNotification(
      route,
      ciphertext,
      loaderFor(
        fakeParser({ outcome: "prepared", notification: { kind: "ping" } }),
      ),
    );

    expect(markread).toEqual({
      kind: "markread",
      tag: "Lounge/#lounge",
      until: `timestamp=${time}`,
    });
    expect(ping).toEqual({ kind: "ping" });
  });

  it("throws a decrypt failure inside the decrypt stage", async () => {
    const failed = vi.fn<(stage: string) => void>();
    const measure: MeasurePushParserStage = async (stage, work) => {
      try {
        return await work();
      } catch (error: unknown) {
        failed(stage);
        throw error;
      }
    };

    await expect(
      preparePushNotification(
        route,
        ciphertext,
        loaderFor(
          fakeParser({
            outcome: "failed",
            stage: "decrypt",
            message: "encrypted push payload failed authentication",
          }),
        ),
        () => undefined,
        measure,
      ),
    ).rejects.toBeInstanceOf(PushDecryptError);
    expect(failed).toHaveBeenCalledExactlyOnceWith("decrypt");
  });

  it("falls back to the generic notification for an unsupported line", async () => {
    const reportError = vi.fn();

    const prepared = await preparePushNotification(
      route,
      ciphertext,
      loaderFor(
        fakeParser({
          outcome: "failed",
          stage: "parse",
          message: "unsupported IRC push command",
        }),
      ),
      reportError,
    );

    expect(prepared).toEqual({
      kind: "generic",
      presentation: genericNotification("Lounge"),
    });
    expect(reportError).toHaveBeenCalledExactlyOnceWith(
      new Error("unsupported IRC push command"),
    );
  });

  it("falls back to the generic notification when the parser cannot load", async () => {
    const reportError = vi.fn();
    const loader = new PushParserLoader(() =>
      Promise.reject(new Error("push parser is not cached")),
    );

    const prepared = await preparePushNotification(
      route,
      ciphertext,
      loader,
      reportError,
    );

    expect(prepared).toEqual({
      kind: "generic",
      presentation: genericNotification("Lounge"),
    });
    expect(reportError).toHaveBeenCalledOnce();
  });

  it("measures loading, decryption and formatting as separate stages", async () => {
    const measured: string[] = [];
    const loader = new PushParserLoader(async (measure) => {
      await measure("parser_cache_lookup", () => undefined);
      await measure("parser_wasm_load", () => undefined);
      return fakeParser(visibleChat);
    });

    await preparePushNotification(
      route,
      ciphertext,
      loader,
      undefined,
      (stage, work) => {
        measured.push(stage);
        return Promise.resolve(work());
      },
    );

    expect(measured).toEqual([
      "parser_cache_lookup",
      "parser_load",
      "parser_wasm_load",
      "decrypt",
      "parse",
    ]);
  });

  it("falls back to the generic notification for malformed preparer output", async () => {
    const reportError = vi.fn();
    const truncatedRecord = {
      ...visibleChat,
      notification: { ...visibleChat.notification, pushed: { schema: 1 } },
    };

    for (const parser of [
      fakeParser(truncatedRecord),
      { ...fakeParser(visibleChat), prepare_notification: () => "{not json" },
    ]) {
      await expect(
        preparePushNotification(
          route,
          ciphertext,
          loaderFor(parser),
          reportError,
        ),
      ).resolves.toEqual({
        kind: "generic",
        presentation: genericNotification("Lounge"),
      });
    }
    expect(reportError).toHaveBeenCalledTimes(2);
  });
});

describe("PushParserLoader", () => {
  it("retries loading after a cached failure", async () => {
    const parser = fakeParser(visibleChat);
    const load = vi
      .fn<() => Promise<PushPayloadParser>>()
      .mockRejectedValueOnce(new Error("parser cache is unavailable"))
      .mockResolvedValue(parser);
    const loader = new PushParserLoader(load);

    await expect(loader.load()).rejects.toThrow("parser cache is unavailable");
    await expect(loader.load()).resolves.toBe(parser);
    await expect(loader.load()).resolves.toBe(parser);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

function fakeParser(outcome: object) {
  return {
    prepare_notification: vi.fn(() => JSON.stringify(outcome)),
    counted_notification_body: vi.fn(
      (body: string, count: number) => `${body} (${count})`,
    ),
  } satisfies PushPayloadParser;
}

function loaderFor(parser: PushPayloadParser): PushParserLoader {
  return new PushParserLoader(async () => parser);
}
