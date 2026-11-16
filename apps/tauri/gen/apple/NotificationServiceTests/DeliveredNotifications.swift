import UserNotifications
import XCTest

/// Chat notifications a test posts to the dev app's Notification Center, removed afterwards.
struct DeliveredNotifications {
  private let center = UNUserNotificationCenter.current()
  private let test: XCTestCase

  init(_ test: XCTestCase) {
    self.test = test
  }

  /// Posts a message notification shaped like the extension's and returns once it is delivered;
  /// the dev app must be allowed to notify, or this waits until the test times out.
  func post(conversation tag: String, at time: String) async throws -> String {
    let identifier = "test-\(UUID().uuidString)"
    let content = UNMutableNotificationContent()
    content.title = "mel"
    content.body = "posted by a test"
    content.userInfo = [
      "route": "/Libera/weblounge", "conversationTag": tag, "messageId": identifier,
      "messageTime": time,
    ]
    test.addTeardownBlock { [center] in
      center.removeDeliveredNotifications(withIdentifiers: [identifier])
    }
    try await center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    while await !identifiers().contains(identifier) {
      await Task.yield()
    }
    return identifier
  }

  func identifiers() async -> [String] {
    await center.deliveredNotifications().map(\.request.identifier)
  }
}
