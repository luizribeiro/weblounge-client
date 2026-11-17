import { expect, type Locator, type Page } from "@playwright/test";
import { type IrcClient, messageId, serverTime } from "./irc-client";
import { scrollToTranscriptTop } from "./message-list-scroll";
import { isPhoneViewport } from "./mobile-platform";
import { escapeRegex } from "./sidebar-rows";

const serverPageLimit = 100;
const badgeCap = 99;
// Without event-playback, Ergo replays joins and parts as HistServ lines; the app shows them as
// membership rows.
const historyService = "HistServ";

export interface ServerMessage {
  readonly msgid: string;
  readonly author: string;
  readonly text: string;
  readonly timeMs: number;
}

export type TranscriptRow =
  | { readonly kind: "message"; readonly msgids: string; readonly text: string }
  | { readonly kind: "tombstone"; readonly msgids: string }
  | { readonly kind: "pending"; readonly text: string }
  | { readonly kind: "gap"; readonly label: string };

export interface TranscriptMismatch {
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly duplicated: readonly string[];
  readonly outOfOrder: boolean;
  readonly gaps: readonly string[];
  readonly pending: readonly string[];
}

/** Every PRIVMSG and NOTICE the server's history holds for a target, oldest first. */
export async function serverHistory(
  truth: IrcClient,
  target: string,
): Promise<readonly ServerMessage[]> {
  const lines: string[] = [];
  let page = await truth.chathistory("LATEST", target, ["*"], serverPageLimit);
  while (page.length > 0) {
    lines.unshift(...page);
    page = await truth.chathistory(
      "BEFORE",
      target,
      [`msgid=${messageId(page[0] ?? "")}`],
      serverPageLimit,
    );
  }
  return lines
    .filter((line) => / (?:PRIVMSG|NOTICE) /u.test(line))
    .map(parseServerMessage)
    .filter((message) => message.author !== historyService);
}

function parseServerMessage(line: string): ServerMessage {
  const [, prefix = "", body = ""] =
    /^(?:@\S+ )?:(\S+) (?:PRIVMSG|NOTICE) \S+ :(.*)$/u.exec(line) ?? [];
  return {
    msgid: messageId(line),
    author: prefix.split("!")[0] ?? "",
    text: withoutAction(body),
    timeMs: Date.parse(serverTime(line)),
  };
}

function withoutAction(body: string): string {
  const delimiter = String.fromCharCode(1);
  const action = `${delimiter}ACTION `;
  return body.startsWith(action) && body.endsWith(delimiter)
    ? body.slice(action.length, -1)
    : body;
}

/** What the transcript must show: the server's msgids, in order, each once, and nothing else. */
export function transcriptMismatch(
  rows: readonly TranscriptRow[],
  server: readonly ServerMessage[],
): TranscriptMismatch {
  const expected = server.map((message) => message.msgid);
  const expectedSet = new Set(expected);
  const shown = rows.flatMap((row) =>
    row.kind === "message" ? row.msgids.split(" ") : [],
  );
  const tombstones = rows.flatMap((row) =>
    row.kind === "tombstone" ? row.msgids.split(" ") : [],
  );
  const counts = new Map<string, number>();
  for (const msgid of shown) counts.set(msgid, (counts.get(msgid) ?? 0) + 1);
  const shownSet = new Set(shown);
  const inOrder = shown.filter((msgid) => expectedSet.has(msgid));
  return {
    missing: expected.filter((msgid) => !shownSet.has(msgid)),
    unexpected: [
      ...shown.filter((msgid) => !expectedSet.has(msgid)),
      ...tombstones.filter((msgid) => expectedSet.has(msgid)),
    ],
    duplicated: [...counts].flatMap(([msgid, count]) =>
      count > 1 ? [msgid] : [],
    ),
    outOfOrder:
      inOrder.join(" ") !==
      expected.filter((msgid) => shownSet.has(msgid)).join(" "),
    gaps: rows.flatMap((row) => (row.kind === "gap" ? [row.label] : [])),
    pending: rows.flatMap((row) => (row.kind === "pending" ? [row.text] : [])),
  };
}

export const matchingTranscript: TranscriptMismatch = {
  missing: [],
  unexpected: [],
  duplicated: [],
  outOfOrder: false,
  gaps: [],
  pending: [],
};

/**
 * The open conversation's transcript, scrolled back to the start of server history, equals the
 * server's history for its target; a gap row passes only once it has backfilled.
 */
export async function expectTranscriptMatchesServer(
  page: Page,
  truth: IrcClient,
  target: string,
): Promise<void> {
  const server = await serverHistory(truth, target);
  expect(server.length, `server history of ${target}`).toBeGreaterThan(0);
  await expect
    .poll(
      async () => {
        await loadAllOlderHistory(page);
        return transcriptMismatch(await readTranscript(page), server);
      },
      { message: `transcript of ${target} matches server history` },
    )
    .toEqual(matchingTranscript);
}

async function loadAllOlderHistory(page: Page): Promise<void> {
  const list = activeMessageList(page);
  while (!(await reachedHistoryStart(list))) {
    const oldest = await oldestRowKey(list);
    await scrollToTranscriptTop(list);
    await expect
      .poll(
        async () =>
          (await reachedHistoryStart(list)) ||
          (await oldestRowKey(list)) !== oldest,
        { message: "an older history page loads" },
      )
      .toBe(true);
  }
}

function reachedHistoryStart(list: Locator): Promise<boolean> {
  return list.evaluate(
    (element) =>
      element.querySelector(
        '[data-divider-kind="history"], [data-divider-kind="empty"]',
      ) !== null,
  );
}

function oldestRowKey(list: Locator): Promise<string | undefined> {
  return list.evaluate((element) => {
    const rows = [
      ...element.querySelectorAll<HTMLElement>("li[data-row-key]"),
    ].sort(
      (first, second) =>
        Number(first.dataset.index) - Number(second.dataset.index),
    );
    return rows.find((row) => row.querySelector("[data-message-row]"))?.dataset
      .rowKey;
  });
}

/** Sweeps the virtualized transcript from the top, where history starts, to the live edge. */
export function readTranscript(page: Page): Promise<TranscriptRow[]> {
  return activeMessageList(page).evaluate(async (list) => {
    const collected = new Map<number, TranscriptRow | null>();
    const frames = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    const collect = () => {
      for (const row of list.querySelectorAll<HTMLElement>(
        "li[data-row-key]",
      )) {
        collected.set(Number(row.dataset.index), describe(row));
      }
    };
    const step = Math.max(1, Math.floor(list.clientHeight / 2));
    list.scrollTop = 0;
    await frames();
    collect();
    while (list.scrollTop + list.clientHeight < list.scrollHeight - 1) {
      list.scrollTop += step;
      list.dispatchEvent(new Event("scroll"));
      await frames();
      collect();
    }
    const indexes = [...collected.keys()].sort(
      (first, second) => first - second,
    );
    const contiguous = indexes.every((index, position) => index === position);
    if (!contiguous)
      throw new Error(`transcript sweep skipped rows: ${indexes.join(",")}`);
    return indexes.flatMap((index) => {
      const row = collected.get(index);
      return row === null || row === undefined ? [] : [row];
    });

    function describe(row: HTMLElement): TranscriptRow | null {
      const gap = row.querySelector<HTMLElement>("[data-gap-row]");
      if (gap !== null)
        return { kind: "gap", label: gap.getAttribute("aria-label") ?? "" };
      const message = row.querySelector<HTMLElement>("[data-message-row]");
      if (message === null) return null;
      const msgids = message.dataset.msgids;
      const text = message.dataset.messageText ?? "";
      if (msgids === undefined)
        return message.dataset.noticeRow === undefined
          ? { kind: "pending", text }
          : null;
      return message.querySelector("[data-redacted]") === null
        ? { kind: "message", msgids, text }
        : { kind: "tombstone", msgids };
    }
  });
}

export function activeMessageList(page: Page): Locator {
  return page.locator("[data-message-list]:visible");
}

/**
 * The chat-list row's unread badge counts the other people's server lines after the server's
 * read marker; on the phone its preview is the newest server line.
 */
export async function expectChatRowMatchesServer(
  page: Page,
  truth: IrcClient,
  target: string,
  ownNick: string,
): Promise<void> {
  const server = await serverHistory(truth, target);
  const marker = await truth.readMarker(target);
  const markerMs = marker === undefined ? undefined : Date.parse(marker);
  const unread = server.filter(
    (message) =>
      message.author.toLowerCase() !== ownNick.toLowerCase() &&
      (markerMs === undefined || message.timeMs > markerMs),
  ).length;
  const row = chatRow(page, target);
  const badge = row.locator("[data-badge-kind]");
  if (unread === 0) await expect(badge).toHaveCount(0);
  else
    await expect(badge).toHaveText(unread > badgeCap ? "99+" : String(unread));
  const newest = server.at(-1);
  if (isPhoneViewport(page) && newest !== undefined)
    await expect(row).toContainText(newest.text);
}

export function chatRow(page: Page, title: string): Locator {
  return page
    .locator("[data-buffer-id]")
    .and(
      page.getByRole("button", {
        name: new RegExp(`^${escapeRegex(title)}(?:,|$)`, "u"),
      }),
    )
    .first();
}

/**
 * Waits until the engine has received one whole CHATHISTORY page for a target, so that opening
 * the buffer afterwards shows what that page left behind. Needs `captureHistoryWire`.
 */
export async function expectHistoryPageReceived(
  page: Page,
  target: string,
): Promise<void> {
  await expect
    .poll(() => page.evaluate(historyPageReceived, target), {
      message: `a history page for ${target} arrives`,
    })
    .toBe(true);
}

function historyPageReceived(target: string): boolean {
  const timeline: unknown = Reflect.get(globalThis, "historyWireTimeline");
  if (!Array.isArray(timeline)) return false;
  const received = timeline.flatMap((entry: unknown) =>
    typeof entry === "object" &&
    entry !== null &&
    "direction" in entry &&
    entry.direction === "received" &&
    "line" in entry &&
    typeof entry.line === "string"
      ? [entry.line]
      : [],
  );
  const start = received.find(
    (line) =>
      / BATCH \+\S+ chathistory /u.test(line) &&
      line.toLowerCase().endsWith(` ${target.toLowerCase()}`),
  );
  const reference =
    start === undefined ? undefined : / BATCH \+(\S+) /u.exec(start)?.[1];
  return (
    reference !== undefined &&
    received.some((line) => line.includes(` BATCH -${reference}`))
  );
}
