import XCTest

final class RelayPushTests: XCTestCase {
  func testDecodesUnpaddedBase64URL() {
    XCTAssertEqual(Data(base64URLEncoded: "-__-"), Data([0xfb, 0xff, 0xfe]))
    XCTAssertEqual(Data(base64URLEncoded: "_-8"), Data([0xff, 0xef]))
    XCTAssertEqual(Data(base64URLEncoded: "_w"), Data([0xff]))
    XCTAssertEqual(Data(base64URLEncoded: ""), Data())
  }

  func testRejectsTextThatIsNotBase64URL() {
    XCTAssertNil(Data(base64URLEncoded: "not base64!"))
    XCTAssertNil(Data(base64URLEncoded: "abcde"))
  }

  func testReadsTheRouteAndRecordFromTheRelaysPayload() {
    let push = RelayPush([
      "aps": ["alert": ["title": "weblounge", "body": "New message"], "mutable-content": 1],
      "r": "kq3VJbW1xX0aY9Zr2pLm4w", "c": "Y2lwaGVydGV4dA",
    ])

    XCTAssertEqual(push?.routeId, "kq3VJbW1xX0aY9Zr2pLm4w")
    XCTAssertEqual(push?.ciphertext, Data("ciphertext".utf8))
  }

  func testPreparesWithTheStoredRoutesKeysOrNotAtAll() throws {
    let route = try StoredTestRoute(self)
    let record = base64URL(
      try route.sealer.seal(
        "@time=2026-11-16T22:42:00.000Z;msgid=m3-2 :mel!m@example.test PRIVMSG weblounge :hi"))

    let prepared = RelayPush(["r": route.routeId, "c": record])?.prepare(route.storage)

    XCTAssertEqual(prepared.map { isVisible($0.outcome) }, true)
    XCTAssertNil(RelayPush(["r": "dropped-route", "c": record])?.prepare(route.storage))
  }

  func testIgnoresAPushWithoutARouteOrRecord() {
    XCTAssertNil(RelayPush(["r": "kq3VJbW1xX0aY9Zr2pLm4w"]))
    XCTAssertNil(RelayPush(["c": "Y2lwaGVydGV4dA"]))
    XCTAssertNil(RelayPush(["aps": ["alert": "New message"]]))
  }
}
