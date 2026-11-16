import XCTest

/// A route whose keys and metadata sit in the dev app's keychain and App Group for one test.
/// The test starts with no notification counts (restored afterwards) and an empty queue.
struct StoredTestRoute {
  let storage: SharedStorage
  let sealer = WebPushSealer()
  let routeId = "test-\(UUID().uuidString)"

  init(_ test: XCTestCase) throws {
    let storage = try SharedStorage.fromInfoPlist()
    self.storage = storage
    let routeId = self.routeId
    let defaults = try XCTUnwrap(UserDefaults(suiteName: storage.appGroup))
    let savedCounts = defaults.data(forKey: SharedStorage.notificationCountsKey)
    test.addTeardownBlock {
      defaults.set(savedCounts, forKey: SharedStorage.notificationCountsKey)
      for secret in RouteSecret.allCases {
        try? storage.deleteSecret(secret, routeId: routeId)
      }
      try? storage.deleteRouteMeta(routeId: routeId)
      try? storage.clearReregistrationFlag(routeId: routeId)
    }
    try storage.writeNotificationCounts([])
    _ = try storage.drainPushedMessages()
    try storage.storeSecret(.privateKeyPkcs8, routeId: routeId, data: sealer.privateKeyPkcs8)
    try storage.storeSecret(.auth, routeId: routeId, data: sealer.auth)
    try storage.storeRouteMeta(
      RouteMeta(networkId: 3, networkLabel: "Libera", nickname: "weblounge"), routeId: routeId)
  }

  func setCountsData(_ data: Data) {
    UserDefaults(suiteName: storage.appGroup)?.set(data, forKey: SharedStorage.notificationCountsKey)
  }

  func countsData() -> Data? {
    UserDefaults(suiteName: storage.appGroup)?.data(forKey: SharedStorage.notificationCountsKey)
  }

  /// The relay's APNs payload for `ircLine` on this route.
  func relayPayload(_ ircLine: String) throws -> [AnyHashable: Any] {
    [
      "aps": ["alert": ["title": "weblounge", "body": "New message"], "mutable-content": 1],
      "r": routeId, "c": base64URL(try sealer.seal(ircLine)),
    ]
  }
}

func base64URL(_ data: Data) -> String {
  data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

func isVisible(_ outcome: PrepareOutcome) -> Bool {
  if case .prepared(.visible) = outcome { return true }
  return false
}
