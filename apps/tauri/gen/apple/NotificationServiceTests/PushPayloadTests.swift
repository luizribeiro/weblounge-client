import XCTest

final class PushPayloadTests: XCTestCase {
  func testAddsTheCountLineOnlyForSeveralMessages() {
    XCTAssertEqual(
      PushPayload.countedBody("lunch?", count: 3, newMessages: "· {count} new messages"),
      "lunch?\n· 3 new messages")
    XCTAssertEqual(
      PushPayload.countedBody("lunch?", count: 1, newMessages: "· {count} new messages"), "lunch?")
  }
}
