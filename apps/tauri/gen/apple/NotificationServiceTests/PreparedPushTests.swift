import XCTest

final class PreparedPushTests: XCTestCase {
  private let sealer = WebPushSealer()
  private let route = RouteMeta(networkId: 3, networkLabel: "Libera", nickname: "weblounge")

  private func prepare(_ ircLine: String, sealedBy sealer: WebPushSealer? = nil) throws
    -> PrepareOutcome
  {
    let json = try XCTUnwrap(
      PushPayload.prepare(
        ciphertext: try (sealer ?? self.sealer).seal(ircLine),
        privateKeyPkcs8: self.sealer.privateKeyPkcs8, auth: self.sealer.auth, route: route))
    return try PrepareOutcome.decode(json)
  }

  func testPreparesAChannelMentionWithThePagesNotificationData() throws {
    let outcome = try prepare(
      "@time=2026-11-16T22:41:07.512Z;msgid=m3-1 :mel!m@example.test PRIVMSG #weblounge :weblounge: lunch?"
    )

    XCTAssertEqual(
      outcome,
      .prepared(
        .visible(
          VisibleNotification(
            title: "mel in #weblounge", body: "weblounge: lunch?", threadId: "Libera/#weblounge",
            userInfo: [
              "route": "/Libera/weblounge", "conversationTag": "Libera/#weblounge",
              "messageId": "m3-1", "messageTime": "2026-11-16T22:41:07.512Z",
            ]))))
  }

  func testPreparesADirectMessageInTheSendersConversation() throws {
    guard
      case .prepared(.visible(let visible)) = try prepare(
        "@time=2026-11-16T22:42:00.000Z;msgid=m3-2 :mel!m@example.test PRIVMSG weblounge :are you around?"
      )
    else { return XCTFail("not visible") }

    XCTAssertEqual(visible.title, "mel")
    XCTAssertEqual(visible.conversationTag, "Libera/mel")
    XCTAssertEqual(visible.messageId, "m3-2")
    XCTAssertEqual(visible.messageTime, "2026-11-16T22:42:00.000Z")
  }

  func testPreparesAnInviteWithoutConversationFields() throws {
    guard
      case .prepared(.visible(let visible)) = try prepare(
        ":mel!m@example.test INVITE weblounge #secret")
    else { return XCTFail("not visible") }

    XCTAssertEqual(visible.body, "Invited you to #secret")
    XCTAssertNil(visible.conversationTag)
    XCTAssertNil(visible.messageId)
    XCTAssertEqual(visible.userInfo["route"], "/Libera/secret")
  }

  func testPreparesARemoteReadMarkerAndAPing() throws {
    XCTAssertEqual(
      try prepare(":irc.example.test MARKREAD #weblounge timestamp=2026-11-16T22:45:00.000Z"),
      .prepared(.markread(tag: "Libera/#weblounge", until: "timestamp=2026-11-16T22:45:00.000Z")))
    XCTAssertEqual(try prepare("PING :push-registration"), .prepared(.ping))
  }

  func testReportsADecryptFailureForAnotherRoutesRecord() throws {
    XCTAssertEqual(
      try prepare(":mel!m@example.test PRIVMSG weblounge :hi", sealedBy: WebPushSealer()),
      .failed(.decrypt))
  }

  func testReportsAParseFailureForAnUnsupportedEvent() throws {
    XCTAssertEqual(try prepare(":mel!m@example.test JOIN #weblounge"), .failed(.parse))
  }

  func testRejectsAnOutcomeItDoesNotKnow() {
    XCTAssertThrowsError(try PrepareOutcome.decode(Data(#"{"outcome":"deferred"}"#.utf8)))
    XCTAssertThrowsError(
      try PrepareOutcome.decode(
        Data(#"{"outcome":"prepared","notification":{"kind":"silent"}}"#.utf8)))
  }
}
