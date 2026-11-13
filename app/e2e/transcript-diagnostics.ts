import type { Page, TestInfo } from "@playwright/test";

const edgeRowCount = 5;

interface MountedRow {
  readonly index: number | null;
  readonly key: string | null;
  readonly text: string | null;
  readonly transform: string;
}

export async function withTranscriptDiagnostics<T>(
  page: Page,
  testInfo: TestInfo,
  assertion: () => Promise<T>,
): Promise<T> {
  try {
    return await assertion();
  } catch (error) {
    await attachTranscriptDiagnostics(page, testInfo).catch(() => undefined);
    throw error;
  }
}

async function attachTranscriptDiagnostics(
  page: Page,
  testInfo: TestInfo,
): Promise<void> {
  const snapshot = await page
    .evaluate(readTranscriptGeometry, edgeRowCount)
    .catch((error: unknown) => ({ unavailable: String(error) }));
  // The line reporter prints only the first 300 characters of text/*
  // attachments into the CI log, so the geometry summary leads.
  await testInfo.attach("transcript-geometry", {
    body: JSON.stringify(snapshot),
    contentType: "text/plain",
  });
}

function readTranscriptGeometry(edgeRows: number) {
  const motion = [
    ...document.querySelectorAll<HTMLElement>("[data-motion]"),
  ].map((element) => element.dataset.motion ?? null);
  const list = document.querySelector<HTMLElement>("[data-message-list]");
  if (list === null) return { list: null, motion };
  const rows: MountedRow[] = [
    ...list.querySelectorAll<HTMLElement>("li[data-row-key]"),
  ]
    .map((row) => ({
      index: row.dataset.index === undefined ? null : Number(row.dataset.index),
      key: row.dataset.rowKey ?? null,
      text:
        row
          .querySelector<HTMLElement>("[data-message-text]")
          ?.dataset.messageText?.slice(0, 40) ?? null,
      transform: row.style.transform,
    }))
    .sort((first, second) => (first.index ?? -1) - (second.index ?? -1));
  const sentinel = list.querySelector<HTMLElement>("[data-live-edge-sentinel]");
  const spacer = sentinel?.previousElementSibling;
  const jumpButtons = [
    ...(list.parentElement?.querySelectorAll("button") ?? []),
  ].filter((button) => /new message/u.test(button.textContent ?? ""));
  return {
    scrollTop: list.scrollTop,
    scrollHeight: list.scrollHeight,
    clientHeight: list.clientHeight,
    distanceFromBottom: list.scrollHeight - list.scrollTop - list.clientHeight,
    virtualTotalSize:
      spacer instanceof HTMLElement ? spacer.offsetHeight : null,
    liveEdgeSentinelTop: sentinel?.offsetTop ?? null,
    jumpToNewPresent: jumpButtons.length > 0,
    mountedRowCount: rows.length,
    motion,
    firstMountedRows: rows.slice(0, edgeRows),
    lastMountedRows: rows.slice(-edgeRows),
  };
}
