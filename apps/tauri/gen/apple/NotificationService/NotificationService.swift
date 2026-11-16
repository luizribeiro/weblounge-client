import UserNotifications

/// The Notification Service Extension. Whatever it has prepared when time runs out is
/// delivered, so a slow or failed push still shows the relay's placeholder.
final class NotificationService: UNNotificationServiceExtension {
  private var deliver: ((UNNotificationContent) -> Void)?
  private var best: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    deliver = contentHandler
    best = request.content
    finish()
  }

  override func serviceExtensionTimeWillExpire() {
    finish()
  }

  private func finish() {
    guard let deliver, let best else { return }
    self.deliver = nil
    deliver(best)
  }
}
