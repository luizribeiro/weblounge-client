import UserNotifications

/// Turns one relay push into notification content through push-payload, offering each better
/// version as soon as it has it; anything it can't prepare leaves the relay's placeholder.
struct PushPresenter {
  let storage: SharedStorage
  let offer: (UNNotificationContent) -> Void

  func present(_ placeholder: UNNotificationContent) {
    guard let push = RelayPush(placeholder.userInfo), let outcome = push.prepare(storage) else {
      return
    }
    switch outcome {
    case .prepared(.visible(let visible)):
      show(visible, over: placeholder)
    case .prepared(.markread), .prepared(.ping), .failed:
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
  }
}
