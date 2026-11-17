/** Puts plain text on the clipboard; a refused write (no permission, insecure context) leaves it as it was. */
export function copyText(text: string): void {
  navigator.clipboard?.writeText(text).catch(() => undefined);
}
