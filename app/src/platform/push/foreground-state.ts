import { type HostShell, hostShell } from "../host-shell";
import { currentAppLifecycle } from "../native-bridge/app-lifecycle";
import type { AppLifecycle } from "../native-bridge/generated/AppLifecycle";

interface ForegroundDocument {
  readonly hidden: boolean;
  hasFocus(): boolean;
}

export function pageIsForeground(
  pageDocument: ForegroundDocument,
  browserNavigator: object,
  shell: HostShell = hostShell(),
  lifecycle: AppLifecycle = currentAppLifecycle(),
): boolean {
  if (pageDocument.hidden) return false;
  // WKWebView may not blur or hide the page when the app backgrounds, so the shell reports it.
  if (shell === "ios-app") return lifecycle === "foreground";
  return (
    Reflect.get(browserNavigator, "standalone") === true ||
    pageDocument.hasFocus()
  );
}
