import UserNotifications
import XCTest

final class NotificationServiceTests: XCTestCase {
  private let placeholder: UNNotificationContent = {
    let content = UNMutableNotificationContent()
    content.title = "weblounge"
    content.body = "New message"
    return content
  }()

  private func content(_ body: String) -> UNNotificationContent {
    let content = UNMutableNotificationContent()
    content.body = body
    return content
  }

  /// Receives the placeholder and collects every content the handler is given.
  private func receive(
    _ service: NotificationService, payload: [AnyHashable: Any] = [:],
    delivered: XCTestExpectation
  ) -> () -> [String] {
    let lock = NSLock()
    var bodies: [String] = []
    let request = placeholder.mutableCopy() as! UNMutableNotificationContent
    request.userInfo = payload
    service.didReceive(UNNotificationRequest(identifier: "push", content: request, trigger: nil)) {
      content in
      lock.withLock { bodies.append(content.body) }
      delivered.fulfill()
    }
    return { lock.withLock { bodies } }
  }

  func testDeliversTheFinishedContentOnce() async {
    let delivered = expectation(description: "delivered")
    let service = NotificationService { _, offer in
      offer(self.content("draft"))
      offer(self.content("lunch?"))
    }

    let bodies = receive(service, delivered: delivered)
    await fulfillment(of: [delivered], timeout: 30)
    service.serviceExtensionTimeWillExpire()

    XCTAssertEqual(bodies(), ["lunch?"])
  }

  func testDeliversTheBestContentSoFarWhenTimeRunsOut() async {
    let offered = expectation(description: "offered")
    let delivered = expectation(description: "delivered")
    let finished = expectation(description: "finished")
    let release = AsyncStream<Void>.makeStream()
    let service = NotificationService { _, offer in
      offer(self.content("lunch?"))
      offered.fulfill()
      for await _ in release.stream {}
      offer(self.content("too late"))
      finished.fulfill()
    }

    let bodies = receive(service, delivered: delivered)
    await fulfillment(of: [offered], timeout: 30)
    service.serviceExtensionTimeWillExpire()
    await fulfillment(of: [delivered], timeout: 30)
    release.continuation.finish()
    await fulfillment(of: [finished], timeout: 30)

    XCTAssertEqual(bodies(), ["lunch?"])
  }

  func testDeliversThePlaceholderWhenNothingWasOffered() async {
    let delivered = expectation(description: "delivered")
    let finished = expectation(description: "finished")
    let release = AsyncStream<Void>.makeStream()
    let service = NotificationService { _, _ in
      for await _ in release.stream {}
      finished.fulfill()
    }

    let bodies = receive(service, delivered: delivered)
    service.serviceExtensionTimeWillExpire()
    await fulfillment(of: [delivered], timeout: 30)
    release.continuation.finish()
    await fulfillment(of: [finished], timeout: 30)

    XCTAssertEqual(bodies(), ["New message"])
  }

  func testPresentsARelayPushFromTheSharedStorage() async throws {
    let route = try StoredTestRoute(self)
    let delivered = expectation(description: "delivered")

    let bodies = receive(
      NotificationService(),
      payload: try route.relayPayload(
        "@time=2026-11-16T22:42:00.000Z;msgid=m3-2 :mel!m@example.test PRIVMSG weblounge :hi"),
      delivered: delivered)
    await fulfillment(of: [delivered], timeout: 30)

    XCTAssertEqual(bodies(), ["hi"])
  }
}
