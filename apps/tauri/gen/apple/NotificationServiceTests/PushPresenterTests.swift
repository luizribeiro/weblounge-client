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

  func testLeavesCountsItCannotReadUntouched() throws {
    let route = try StoredTestRoute(self)
    let corrupt = Data("not counts".utf8)
    route.setCountsData(corrupt)

    let content = present(
      try route.relayPayload(
        "@time=2026-11-16T22:41:07.512Z;msgid=m3-1 :mel!m@example.test PRIVMSG #weblounge :lunch?"),
      storage: route.storage
    ).last

    XCTAssertEqual(content?.body, "lunch?")
    XCTAssertNil(content?.badge)
    XCTAssertEqual(route.countsData(), corrupt)
  }

  func testCountsEachMessageInTheBadgeAndTheBody() throws {
    let route = try StoredTestRoute(self)
    try route.storage.writeNotificationCounts([
      NotificationCount(tag: "Libera/mel", count: 1, readAtMs: nil)
    ])

    let first = present(
      try route.relayPayload(
        "@time=2026-11-16T22:41:07.512Z;msgid=m3-1 :mel!m@example.test PRIVMSG #weblounge :lunch?"),
      storage: route.storage
    ).last
    let second = present(
      try route.relayPayload(
        "@time=2026-11-16T22:41:30.000Z;msgid=m3-2 :mel!m@example.test PRIVMSG #weblounge :anyone?"),
      storage: route.storage
    ).last

    XCTAssertEqual(first?.body, "lunch?")
    XCTAssertEqual(first?.badge, 2)
    XCTAssertEqual(second?.body, "anyone?\n· 2 new messages")
    XCTAssertEqual(second?.badge, 3)
    XCTAssertEqual(
      try route.storage.readNotificationCounts().first { $0.tag == "Libera/#weblounge" }?.count, 2)
  }

  func testLeavesAnInviteOutOfTheCounts() throws {
    let route = try StoredTestRoute(self)
    try route.storage.writeNotificationCounts([
      NotificationCount(tag: "Libera/mel", count: 1, readAtMs: nil)
    ])

    let content = present(
      try route.relayPayload(":mel!m@example.test INVITE weblounge #secret"), storage: route.storage
    ).last

    XCTAssertEqual(content?.body, "Invited you to #secret")
    XCTAssertNil(content?.badge)
    XCTAssertEqual(try route.storage.readNotificationCounts().map(\.count), [1])
  }

  func testQueuesTheMessageForTheAppBeforeItsHistoryLoads() throws {
    let route = try StoredTestRoute(self)

    _ = present(
      try route.relayPayload(
        "@time=2026-11-16T22:42:00.000Z;msgid=m3-queue :mel!m@example.test PRIVMSG weblounge :soba/ramen 🍜?"),
      storage: route.storage)
    _ = present(
      try route.relayPayload(":mel!m@example.test INVITE weblounge #secret"), storage: route.storage)

    let queued = try route.storage.drainPushedMessages().compactMap {
      try JSONSerialization.jsonObject(with: $0) as? [String: Any]
    }
    XCTAssertEqual(queued.count, 1)
    XCTAssertEqual(queued.first?["msgid"] as? String, "m3-queue")
    XCTAssertEqual(queued.first?["route"] as? String, "/Libera/@mel")
    XCTAssertEqual(queued.first?["schema"] as? Int, 1)
    XCTAssertEqual(queued.first?["text"] as? String, "soba/ramen 🍜?")
    XCTAssertTrue(queued.first?["account"] is NSNull)
  }

  func testFlagsTheRouteForReregistrationWhenItsKeysNoLongerOpenAPush() throws {
    let route = try StoredTestRoute(self)
    var stale = try route.relayPayload(":mel!m@example.test PRIVMSG weblounge :hi")
    stale["c"] = base64URL(try WebPushSealer().seal(":mel!m@example.test PRIVMSG weblounge :hi"))

    XCTAssertEqual(present(stale, storage: route.storage).count, 0)
    XCTAssertTrue(try route.storage.needsReregistration(routeId: route.routeId))
  }

  func testLeavesTheRouteRegisteredWhenAPushOpensButDoesNotParse() throws {
    let route = try StoredTestRoute(self)

    _ = present(
      try route.relayPayload(":mel!m@example.test JOIN #weblounge"), storage: route.storage)

    XCTAssertFalse(try route.storage.needsReregistration(routeId: route.routeId))
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
