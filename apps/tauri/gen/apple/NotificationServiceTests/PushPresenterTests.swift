import UserNotifications
import XCTest

/// Presents pushes against the dev app's keychain and App Group, as the extension does.
final class PushPresenterTests: XCTestCase {
  private func present(_ payload: [AnyHashable: Any], storage: SharedStorage)
    -> [UNNotificationContent]
  {
    let placeholder = UNMutableNotificationContent()
    placeholder.title = "weblounge"
    placeholder.body = "New message"
    placeholder.userInfo = payload
    var offered: [UNNotificationContent] = []
    PushPresenter(storage: storage) { offered.append($0) }.present(placeholder)
    return offered
  }

  func testShowsTheDecryptedMessageGroupedByConversation() throws {
    let route = try StoredTestRoute(self)

    let offered = present(
      try route.relayPayload(
        "@time=2026-11-16T22:41:07.512Z;msgid=m3-1 :mel!m@example.test PRIVMSG #weblounge :lunch?"),
      storage: route.storage)

    let content = try XCTUnwrap(offered.last)
    XCTAssertEqual(content.title, "mel in #weblounge")
    XCTAssertEqual(content.body, "lunch?")
    XCTAssertEqual(content.threadIdentifier, "Libera/#weblounge")
    XCTAssertEqual(
      content.userInfo as? [String: String],
      [
        "route": "/Libera/weblounge", "conversationTag": "Libera/#weblounge", "messageId": "m3-1",
        "messageTime": "2026-11-16T22:41:07.512Z",
      ])
  }

  func testOffersNothingForWhatItCannotShow() throws {
    let route = try StoredTestRoute(self)
    var dropped = try route.relayPayload(":mel!m@example.test PRIVMSG weblounge :hi")
    dropped["r"] = "dropped-route"
    var garbage = try route.relayPayload("")
    garbage["c"] = base64URL(Data(repeating: 7, count: 120))

    for payload in [
      dropped, garbage,
      try route.relayPayload(":mel!m@example.test JOIN #weblounge"),
      try route.relayPayload("PING :push-registration"),
      try route.relayPayload(":irc.example.test MARKREAD #weblounge timestamp=2026-11-16T22:45:00.000Z"),
    ] {
      XCTAssertEqual(present(payload, storage: route.storage).count, 0)
    }
  }
}
