import UserNotifications
import XCTest

/// Presents pushes against the dev app's keychain and App Group, as the extension does.
final class PushPresenterTests: XCTestCase {
  private func present(_ payload: [AnyHashable: Any], storage: SharedStorage) async
    -> [UNNotificationContent]
  {
    let placeholder = UNMutableNotificationContent()
    placeholder.title = "weblounge"
    placeholder.body = "New message"
    placeholder.userInfo = payload
    var offered: [UNNotificationContent] = []
    await PushPresenter(storage: storage, center: .current()) { offered.append($0) }
      .present(placeholder)
    return offered
  }

  func testShowsTheDecryptedMessageGroupedByConversation() async throws {
    let route = try StoredTestRoute(self)

    let offered = await present(
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

  func testLeavesCountsItCannotReadUntouched() async throws {
    let route = try StoredTestRoute(self)
    let corrupt = Data("not counts".utf8)
    route.setCountsData(corrupt)

    let content = await present(
      try route.relayPayload(
        "@time=2026-11-16T22:41:07.512Z;msgid=m3-1 :mel!m@example.test PRIVMSG #weblounge :lunch?"),
      storage: route.storage
    ).last

    XCTAssertEqual(content?.body, "lunch?")
    XCTAssertNil(content?.badge)
    XCTAssertEqual(route.countsData(), corrupt)
  }

  func testCountsEachMessageInTheBadgeAndTheBody() async throws {
    let route = try StoredTestRoute(self)
    try route.storage.writeNotificationCounts([
      NotificationCount(tag: "Libera/mel", count: 1, readAtMs: nil)
    ])

    let first = await present(
      try route.relayPayload(
        "@time=2026-11-16T22:41:07.512Z;msgid=m3-1 :mel!m@example.test PRIVMSG #weblounge :lunch?"),
      storage: route.storage
    ).last
    let second = await present(
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

  func testReplacesARedeliveredMessageWithoutCountingItAgain() async throws {
    let route = try StoredTestRoute(self)
    try route.storage.writeNotificationCounts([
      NotificationCount(tag: "Libera/#weblounge", count: 1, readAtMs: nil)
    ])
    let center = DeliveredNotifications(self)
    let earlier = try await center.post(
      conversation: "Libera/#weblounge", at: "2026-11-16T22:41:07.512Z", messageId: "m3-again")
    let unrelated = try await center.post(
      conversation: "Libera/#weblounge", at: "2026-11-16T22:41:00.000Z")

    let offered = await present(
      try route.relayPayload(
        "@time=2026-11-16T22:41:07.512Z;msgid=m3-again :mel!m@example.test PRIVMSG #weblounge :lunch?"),
      storage: route.storage)

    let identifiers = await center.identifiers()
    XCTAssertFalse(identifiers.contains(earlier))
    XCTAssertTrue(identifiers.contains(unrelated))
    XCTAssertEqual(offered.last?.body, "lunch?")
    XCTAssertEqual(try route.storage.readNotificationCounts().map(\.count), [1])
  }

  func testLeavesAnInviteOutOfTheCounts() async throws {
    let route = try StoredTestRoute(self)
    try route.storage.writeNotificationCounts([
      NotificationCount(tag: "Libera/mel", count: 1, readAtMs: nil)
    ])

    let content = await present(
      try route.relayPayload(":mel!m@example.test INVITE weblounge #secret"), storage: route.storage
    ).last

    XCTAssertEqual(content?.body, "Invited you to #secret")
    XCTAssertNil(content?.badge)
    XCTAssertEqual(try route.storage.readNotificationCounts().map(\.count), [1])
  }

  func testQueuesTheMessageForTheAppBeforeItsHistoryLoads() async throws {
    let route = try StoredTestRoute(self)

    _ = await present(
      try route.relayPayload(
        "@time=2026-11-16T22:42:00.000Z;msgid=m3-queue :mel!m@example.test PRIVMSG weblounge :soba/ramen 🍜?"),
      storage: route.storage)
    _ = await present(
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

  func testFlagsTheRouteForReregistrationWhenItsKeysNoLongerOpenAPush() async throws {
    let route = try StoredTestRoute(self)
    var stale = try route.relayPayload(":mel!m@example.test PRIVMSG weblounge :hi")
    stale["c"] = base64URL(try WebPushSealer().seal(":mel!m@example.test PRIVMSG weblounge :hi"))

    let offered = await present(stale, storage: route.storage)
    XCTAssertEqual(offered.count, 0)
    XCTAssertTrue(try route.storage.needsReregistration(routeId: route.routeId))
  }

  func testLeavesTheRouteRegisteredWhenAPushOpensButDoesNotParse() async throws {
    let route = try StoredTestRoute(self)

    _ = await present(
      try route.relayPayload(":mel!m@example.test JOIN #weblounge"), storage: route.storage)

    XCTAssertFalse(try route.storage.needsReregistration(routeId: route.routeId))
  }

  func testARemoteReadMarkerWithdrawsWhatItCoversAndLowersTheBadge() async throws {
    let route = try StoredTestRoute(self)
    try route.storage.writeNotificationCounts([
      NotificationCount(tag: "Libera/#weblounge", count: 2, readAtMs: nil),
      NotificationCount(tag: "Libera/mel", count: 1, readAtMs: nil),
    ])
    let center = DeliveredNotifications(self)
    let covered = try await center.post(
      conversation: "Libera/#weblounge", at: "2026-11-16T22:41:07.512Z")
    let newer = try await center.post(
      conversation: "Libera/#weblounge", at: "2026-11-16T22:46:00.000Z")
    let other = try await center.post(conversation: "Libera/mel", at: "2026-11-16T22:30:00.000Z")

    let offered = await present(
      try route.relayPayload(
        ":irc.example.test MARKREAD #weblounge timestamp=2026-11-16T22:45:00.000Z"),
      storage: route.storage)

    let delivered = await center.identifiers()
    XCTAssertFalse(delivered.contains(covered))
    XCTAssertTrue(delivered.contains(newer))
    XCTAssertTrue(delivered.contains(other))
    XCTAssertEqual(offered.last?.body, "New message")
    XCTAssertEqual(offered.last?.badge, 1, "mel's 1 plus #weblounge's, now 0")
    XCTAssertEqual(
      try route.storage.readNotificationCounts().first { $0.tag == "Libera/#weblounge" }?.readAtMs,
      serverTimeMs("2026-11-16T22:45:00.000Z"))
  }

  func testWithdrawsWhatAReadMarkerCoversEvenWhenTheCountsCannotBeRead() async throws {
    let route = try StoredTestRoute(self)
    route.setCountsData(Data("not counts".utf8))
    let center = DeliveredNotifications(self)
    let covered = try await center.post(
      conversation: "Libera/#weblounge", at: "2026-11-16T22:45:00.000Z")

    let offered = await present(
      try route.relayPayload(
        ":irc.example.test MARKREAD #weblounge timestamp=2026-11-16T22:45:00.000Z"),
      storage: route.storage)

    let delivered = await center.identifiers()
    XCTAssertFalse(delivered.contains(covered))
    XCTAssertEqual(offered.count, 0)
    XCTAssertEqual(route.countsData(), Data("not counts".utf8))
  }

  func testOffersNothingForWhatItCannotShow() async throws {
    let route = try StoredTestRoute(self)
    var dropped = try route.relayPayload(":mel!m@example.test PRIVMSG weblounge :hi")
    dropped["r"] = "dropped-route"
    var garbage = try route.relayPayload("")
    garbage["c"] = base64URL(Data(repeating: 7, count: 120))

    for payload in [
      dropped, garbage,
      try route.relayPayload(":mel!m@example.test JOIN #weblounge"),
      try route.relayPayload("PING :push-registration"),
    ] {
      let offered = await present(payload, storage: route.storage)
      XCTAssertEqual(offered.count, 0)
    }
  }
}
