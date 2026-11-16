import UserNotifications

/// Turns one relay push into notification content through push-payload, offering each better
/// version as soon as it has it; anything it can't prepare leaves the relay's placeholder.
struct PushPresenter {
  let storage: SharedStorage
  let center: UNUserNotificationCenter
  let offer: (UNNotificationContent) -> Void

  func present(_ placeholder: UNNotificationContent) async {
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
    case .prepared(.markread(let tag, let until)):
      await markRead(tag: tag, until: until, over: placeholder)
    case .prepared(.ping), .failed(.parse):
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

  /// iOS still shows the relay's placeholder, since hiding a push needs Apple's filtering
  /// entitlement; it is offered again only to carry the lowered badge.
  private func markRead(tag: String, until: String, over placeholder: UNNotificationContent) async {
    guard let untilMs = readMarkerMs(until) else { return }
    let applied = applyReadMarker(tag: tag, untilMs: untilMs)
    if let applied, let content = placeholder.mutableCopy() as? UNMutableNotificationContent {
      content.badge = NSNumber(value: applied.badge)
      offer(content)
    }
    await withdrawRead(tag: tag, untilMs: applied?.marker ?? untilMs)
  }

  /// Nil when the counts can't be read, which then stay untouched.
  private func applyReadMarker(tag: String, untilMs: UInt64) -> (marker: UInt64, badge: Int)? {
    guard let counts = try? storage.readNotificationCounts() else { return nil }
    var ledger = NotificationLedger(counts: counts)
    let marker = ledger.markRead(tag: tag, untilMs: untilMs)
    try? storage.writeNotificationCounts(ledger.counts)
    return (marker, ledger.badge)
  }

  private func withdrawRead(tag: String, untilMs: UInt64) async {
    let read = await center.deliveredNotifications()
      .filter { isRead($0.request.content.userInfo, tag: tag, untilMs: untilMs) }
      .map(\.request.identifier)
    center.removeDeliveredNotifications(withIdentifiers: read)
  }

  /// Counts that can't be read stay untouched, so a bad read never overwrites the page's.
  private func count(
    _ visible: VisibleNotification, tag: String, into content: UNMutableNotificationContent
  ) {
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
