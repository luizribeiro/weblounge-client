const draftPrefix = "weblounge:draft:";
const maxDraftCharacters = 32_768;
const maxTotalCharacters = 262_144;

export function readDraft(draftKey: string, storage?: Storage): string {
  try {
    const value =
      (storage ?? window.sessionStorage).getItem(key(draftKey)) ?? "";
    return value.length <= maxDraftCharacters ? value : "";
  } catch {
    return "";
  }
}

export function writeDraft(
  draftKey: string,
  value: string,
  storage?: Storage,
): void {
  try {
    const target = storage ?? window.sessionStorage;
    const draftStorageKey = key(draftKey);
    if (value === "" || value.length > maxDraftCharacters) {
      target.removeItem(draftStorageKey);
      return;
    }
    let total = value.length;
    for (let index = 0; index < target.length; index += 1) {
      const itemKey = target.key(index);
      if (itemKey?.startsWith(draftPrefix) && itemKey !== draftStorageKey) {
        total += target.getItem(itemKey)?.length ?? 0;
      }
    }
    if (total <= maxTotalCharacters) target.setItem(draftStorageKey, value);
  } catch {
    return;
  }
}

export function removeDraft(draftKey: string, storage?: Storage): void {
  try {
    (storage ?? window.sessionStorage).removeItem(key(draftKey));
  } catch {
    return;
  }
}

function key(draftKey: string): string {
  return `${draftPrefix}${encodeURIComponent(draftKey)}`;
}
