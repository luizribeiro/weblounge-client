import Foundation
import UserNotifications

/// The notification center delegate: taps go to the Rust side, which validates the route.
final class NotificationRouting: NSObject, UNUserNotificationCenterDelegate {
  private let events: ShellEvents

  init(events: ShellEvents) {
    self.events = events
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
      events.send([
        "kind": "tap", "userInfo": jsonUserInfo(response.notification.request.content.userInfo),
      ])
    }
    completionHandler()
  }

  /// A push that arrives while the app is active slipped past the relay's foreground lease; the
  /// page is on screen, so it isn't shown.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    if notification.request.trigger is UNPushNotificationTrigger {
      completionHandler([])
    } else {
      completionHandler([.banner, .list, .sound])
    }
  }
}

/// The JSON-representable entries of a notification's `userInfo`.
func jsonUserInfo(_ userInfo: [AnyHashable: Any]) -> [String: Any] {
  var json: [String: Any] = [:]
  for (key, value) in userInfo {
    if let key = key as? String, JSONSerialization.isValidJSONObject([value]) {
      json[key] = value
    }
  }
  return json
}
