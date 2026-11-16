import {
  type ChannelKey,
  hiddenMembers,
  type MemberVisibility,
} from "./member-visibility";

const storageKey = "weblounge.desktop.member-visibility";
const formatVersion = 1;

interface StoredVisibility {
  readonly version: typeof formatVersion;
  readonly lastChoice: boolean;
  readonly channels: Readonly<Record<string, boolean>>;
}

export function encodeMemberVisibility(visibility: MemberVisibility): string {
  const stored: StoredVisibility = {
    version: formatVersion,
    lastChoice: visibility.lastChoice,
    channels: Object.fromEntries(visibility.byChannel),
  };
  return JSON.stringify(stored);
}

export function decodeMemberVisibility(
  text: string | null | undefined,
): MemberVisibility {
  if (text === null || text === undefined) return hiddenMembers;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return hiddenMembers;
  }
  if (!isStoredVisibility(parsed)) return hiddenMembers;
  return {
    byChannel: new Map(
      Object.entries(parsed.channels).filter(
        (entry): entry is [ChannelKey, boolean] =>
          typeof entry[1] === "boolean",
      ),
    ),
    lastChoice: parsed.lastChoice,
  };
}

export function readMemberVisibility(
  storage: Storage = localStorage,
): MemberVisibility {
  try {
    return decodeMemberVisibility(storage.getItem(storageKey));
  } catch {
    return hiddenMembers;
  }
}

export function writeMemberVisibility(
  visibility: MemberVisibility,
  storage: Storage = localStorage,
): void {
  try {
    storage.setItem(storageKey, encodeMemberVisibility(visibility));
  } catch {
    // The choice still applies for this session when device storage is unavailable.
  }
}

function isStoredVisibility(value: unknown): value is StoredVisibility {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === formatVersion &&
    typeof candidate.lastChoice === "boolean" &&
    typeof candidate.channels === "object" &&
    candidate.channels !== null &&
    !Array.isArray(candidate.channels)
  );
}
