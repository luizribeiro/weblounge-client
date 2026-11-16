import UserNotifications

/// Turns one relay push into notification content through push-payload, offering each better
/// version as soon as it has it; anything it can't prepare leaves the relay's placeholder.
struct PushPresenter {
  let storage: SharedStorage
  let offer: (UNNotificationContent) -> Void

  func present(_ placeholder: UNNotificationContent) {
    guard let push = RelayPush(placeholder.userInfo), let prepared = push.prepare(storage) else {
      return
    }
    switch prepared.outcome {
    case .prepared(.visible(let visible)):
      show(visible, over: placeholder)
      // Best effort: the notification is already shown, and the page still loads history.
      if let pushed = pushedRecord(in: prepared.json) {
        try? storage.appendPushedMessage(pushed)
      }
    case .failed(.decrypt):
      try? storage.flagForReregistration(routeId: push.routeId)
    case .prepared(.markread), .prepared(.ping), .failed(.parse):
      return
    }
  }

  private func show(_ visible: VisibleNotification, over placeholder: UNNotificationContent) {
    let content = UNMutableNotificationContent()
    content.sound = placeholder.sound
    content.title = visible.title
    content.body = visible.body
    content.threadIdentifier = visible.threadId
    content.userInfo = visible.userInfo
    offer(content)
    if let tag = visible.conversationTag {
      count(visible, tag: tag, into: content)
      offer(content)
    }
  }

  /// Counts that can't be read stay untouched, so a bad read never overwrites the page's.
  private func count(_ visible: VisibleNotification, tag: String, into content: UNMutableNotificationContent) {
    guard let counts = try? storage.readNotificationCounts() else { return }
    var ledger = NotificationLedger(counts: counts)
    ledger.record(tag: tag, messageTime: visible.messageTime)
    try? storage.writeNotificationCounts(ledger.counts)
    content.badge = NSNumber(value: ledger.badge)
    content.body =
      PushPayload.countedBody(visible.body, count: ledger.count(tag: tag), newMessages: newMessages)
      ?? visible.body
  }
}

private let newMessages = NSLocalizedString(
  "notifications.new_messages", value: "· {count} new messages",
  comment: "The unread-count line under a notification; {count} is the number")
