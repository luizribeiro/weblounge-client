interface ForegroundDocument {
  readonly hidden: boolean;
  hasFocus(): boolean;
}

export function pageIsForeground(
  pageDocument: ForegroundDocument,
  browserNavigator: object,
): boolean {
  return (
    !pageDocument.hidden &&
    (Reflect.get(browserNavigator, "standalone") === true ||
      pageDocument.hasFocus())
  );
}
