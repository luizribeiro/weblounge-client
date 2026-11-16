import UserNotifications

/// Replaces the relay's placeholder with the decrypted message. Whatever has been offered when
/// time runs out is delivered, so a slow or failed push still shows the placeholder.
final class NotificationService: UNNotificationServiceExtension {
  typealias Present = (
    _ placeholder: UNNotificationContent, _ offer: @escaping (UNNotificationContent) -> Void
  ) async -> Void

  private struct Pending {
    let deliver: (UNNotificationContent) -> Void
    var best: UNNotificationContent
  }

  private let present: Present
  private let lock = NSLock()
  private var pending: Pending?

  init(present: @escaping Present) {
    self.present = present
    super.init()
  }

  override convenience init() {
    self.init(present: presentFromSharedStorage)
  }

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    lock.withLock { pending = Pending(deliver: contentHandler, best: request.content) }
    Task { [present] in
      await present(request.content) { self.offer($0) }
      self.finish()
    }
  }

  override func serviceExtensionTimeWillExpire() {
    finish()
  }

  /// Keeps a copy: the presenter goes on refining its mutable content after offering it.
  private func offer(_ content: UNNotificationContent) {
    guard let snapshot = content.copy() as? UNNotificationContent else { return }
    lock.withLock { pending?.best = snapshot }
  }

  /// Only the first call delivers, so a presentation still running at expiry is ignored.
  private func finish() {
    let ready = lock.withLock { () -> Pending? in
      let ready = pending
      pending = nil
      return ready
    }
    ready.map { $0.deliver($0.best) }
  }
}

private func presentFromSharedStorage(
  _ placeholder: UNNotificationContent, offer: @escaping (UNNotificationContent) -> Void
) async {
  guard let storage = try? SharedStorage.fromInfoPlist() else { return }
  PushPresenter(storage: storage, offer: offer).present(placeholder)
}
