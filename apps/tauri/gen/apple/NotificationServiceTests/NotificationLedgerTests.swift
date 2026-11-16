import XCTest

final class NotificationLedgerTests: XCTestCase {
  private let channel = "Libera/#weblounge"
  private let direct = "Libera/mel"

  private func ledger() -> NotificationLedger {
    NotificationLedger(counts: [
      NotificationCount(tag: channel, count: 2, readAtMs: nil),
      NotificationCount(tag: direct, count: 0, readAtMs: serverTimeMs("2026-11-16T22:40:00.000Z")),
    ])
  }

  private func marker(_ ledger: NotificationLedger, _ tag: String) -> UInt64? {
    ledger.counts.first { $0.tag == tag }?.readAtMs
  }

  func testCountsANewMessageInItsConversationAndTheBadge() {
    var ledger = ledger()

    ledger.record(tag: channel, messageTime: "2026-11-16T22:41:07.512Z")

    XCTAssertEqual(ledger.count(tag: channel), 3)
    XCTAssertEqual(ledger.badge, 3)
    XCTAssertEqual(ledger.counts.map(\.tag), [channel, direct])
  }

  func testStartsACountForAConversationTheEngineHasNotWritten() {
    var ledger = NotificationLedger(counts: [])

    ledger.record(tag: "OFTC/#rust", messageTime: "2026-11-16T22:41:07.512Z")
    ledger.record(tag: "OFTC/#rust", messageTime: "2026-11-16T22:41:09.000Z")

    XCTAssertEqual(ledger.count(tag: "OFTC/#rust"), 2)
    XCTAssertEqual(ledger.badge, 2)
  }

  func testLeavesAMessageTheConversationWasReadPastUncounted() {
    var ledger = ledger()

    ledger.record(tag: direct, messageTime: "2026-11-16T22:39:59.999Z")
    ledger.record(tag: direct, messageTime: "2026-11-16T22:40:00.000Z")

    XCTAssertEqual(ledger.count(tag: direct), 0)
    XCTAssertEqual(ledger.badge, 2)
    XCTAssertEqual(marker(ledger, direct), serverTimeMs("2026-11-16T22:40:00.000Z"))
  }

  func testCountsAMessageNewerThanTheReadMarkerAndDropsTheMarker() {
    var ledger = ledger()

    ledger.record(tag: direct, messageTime: "2026-11-16T22:40:00.001Z")

    XCTAssertEqual(ledger.count(tag: direct), 1)
    XCTAssertNil(marker(ledger, direct))
  }

  func testCountsAMessageWithoutAComparableTime() {
    var ledger = ledger()

    ledger.record(tag: direct, messageTime: nil)
    ledger.record(tag: direct, messageTime: "yesterday")
    ledger.record(tag: direct, messageTime: "2026-11-16")

    XCTAssertEqual(ledger.count(tag: direct), 3)
  }

  func testMarkingReadZeroesTheConversationAndKeepsTheLaterMarker() {
    var ledger = ledger()
    let later = serverTimeMs("2026-11-16T22:45:00.000Z")

    XCTAssertEqual(ledger.markRead(tag: channel, untilMs: later!), later)
    XCTAssertEqual(
      ledger.markRead(tag: direct, untilMs: serverTimeMs("2026-11-16T22:00:00.000Z")!),
      serverTimeMs("2026-11-16T22:40:00.000Z"))
    ledger.markRead(tag: "OFTC/#rust", untilMs: later!)

    XCTAssertEqual(ledger.count(tag: channel), 0)
    XCTAssertEqual(ledger.badge, 0)
    XCTAssertEqual(marker(ledger, channel), later)
    XCTAssertEqual(marker(ledger, direct), serverTimeMs("2026-11-16T22:40:00.000Z"))
    XCTAssertEqual(marker(ledger, "OFTC/#rust"), later)
  }

  func testReadsMarkerReferences() {
    XCTAssertEqual(readMarkerMs("timestamp=2026-11-16T22:41:07.512Z"), 1_794_868_867_512)
    XCTAssertEqual(readMarkerMs("2026-11-16T22:41:07.512Z"), 1_794_868_867_512)
    XCTAssertNil(readMarkerMs("timestamp=*"))
  }

  func testMatchesTheDeliveredMessagesAMarkerHasRead() {
    let until = serverTimeMs("2026-11-16T22:45:00.000Z")!
    let message = { (tag: String, time: String) -> [AnyHashable: Any] in
      ["route": "/Libera/weblounge", "conversationTag": tag, "messageId": "m", "messageTime": time]
    }

    XCTAssertTrue(isRead(message(channel, "2026-11-16T22:45:00.000Z"), tag: channel, untilMs: until))
    XCTAssertFalse(isRead(message(channel, "2026-11-16T22:45:00.001Z"), tag: channel, untilMs: until))
    XCTAssertFalse(isRead(message(direct, "2026-11-16T22:00:00.000Z"), tag: channel, untilMs: until))
    XCTAssertFalse(isRead(["route": "/Libera/secret"], tag: channel, untilMs: until))
    XCTAssertFalse(
      isRead(["conversationTag": channel, "messageTime": "soon"], tag: channel, untilMs: until))
    XCTAssertFalse(
      isRead(["conversationTag": channel, "messageTime": 1], tag: channel, untilMs: until))
  }

  func testReadsServerTimes() {
    XCTAssertEqual(serverTimeMs("2026-11-16T22:41:07.512Z"), 1_794_868_867_512)
    XCTAssertEqual(serverTimeMs("2026-11-16T22:41:07Z"), 1_794_868_867_000)
    XCTAssertEqual(serverTimeMs("2026-11-16T23:41:07.512+01:00"), 1_794_868_867_512)
    XCTAssertNil(serverTimeMs("1969-12-31T23:59:59.000Z"))
  }
}
