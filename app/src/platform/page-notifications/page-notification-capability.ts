export function supportsPageNotifications(browserWindow: Window): boolean {
  return "Notification" in browserWindow;
}
