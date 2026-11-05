import type { NotificationPresentation } from "./push-notification";

export async function replaceDeadlineFallback(
  fallback: NotificationPresentation,
  replacement: NotificationPresentation,
  present: (presentation: NotificationPresentation) => Promise<void>,
): Promise<boolean> {
  const fallbackId = fallback.fallbackId;
  const tag = fallback.options.tag;
  if (fallbackId === undefined || tag === undefined) return false;
  await present({
    ...replacement,
    options: {
      ...replacement.options,
      tag,
      data: replacementData(
        replacement.options.data,
        fallbackId,
        replacement.options.tag,
      ),
    },
  });
  return true;
}

function replacementData(
  data: unknown,
  fallbackId: string,
  conversationTag: string | undefined,
): unknown {
  return typeof data === "object" && data !== null
    ? { ...data, fallbackId, conversationTag }
    : { fallbackId, conversationTag };
}
