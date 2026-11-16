import Foundation
import Security

/// A route's push metadata, the bridge's `RouteMeta`.
struct RouteMeta: Codable {
  let networkId: UInt64
  let networkLabel: String
  let nickname: String
}

/// One conversation's unread count, the bridge's `ConversationNotificationCount`.
struct NotificationCount: Codable {
  let tag: String
  let count: UInt32
  let readAtMs: UInt64?
}

/// A route's secret, stored raw so the extension passes it straight to
/// `weblounge_prepare_notification`.
enum RouteSecret: String, CaseIterable {
  case privateKeyPkcs8 = "org.weblounge.route.private-key-pkcs8"
  case auth = "org.weblounge.route.auth"
}

enum SharedStorageError: Error, CustomStringConvertible {
  case missingInfoKey(String)
  case appGroupUnavailable(String)
  case keychain(OSStatus)

  var description: String {
    switch self {
    case .missingInfoKey(let key): return "Info.plist has no \(key)"
    case .appGroupUnavailable(let group): return "App Group \(group) is unavailable"
    case .keychain(let status):
      return SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
    }
  }
}

/// What the app and its Notification Service Extension share. Both targets name the same App
/// Group and keychain group in their Info.plist, derived from the app's bundle identifier,
/// because the extension's own identifier differs.
struct SharedStorage {
  static let appGroupInfoKey = "WebloungeAppGroup"
  static let keychainGroupInfoKey = "WebloungeKeychainGroup"
  static let routeMetaKeyPrefix = "route-meta."
  static let notificationCountsKey = "notification-counts"
  static let pushedMessagesFolder = "PushedMessages"

  let appGroup: String
  let keychainGroup: String

  static func fromInfoPlist(_ bundle: Bundle = .main) throws -> SharedStorage {
    SharedStorage(
      appGroup: try infoString(appGroupInfoKey, bundle),
      keychainGroup: try infoString(keychainGroupInfoKey, bundle))
  }

  private static func infoString(_ key: String, _ bundle: Bundle) throws -> String {
    guard let value = bundle.object(forInfoDictionaryKey: key) as? String, !value.isEmpty else {
      throw SharedStorageError.missingInfoKey(key)
    }
    return value
  }

  private func container() throws -> URL {
    guard
      let url = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroup)
    else { throw SharedStorageError.appGroupUnavailable(appGroup) }
    return url
  }

  private func defaults() throws -> UserDefaults {
    _ = try container()
    guard let defaults = UserDefaults(suiteName: appGroup) else {
      throw SharedStorageError.appGroupUnavailable(appGroup)
    }
    return defaults
  }
}

extension SharedStorage {
  private func secretQuery(_ secret: RouteSecret, routeId: String) -> [CFString: Any] {
    [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: secret.rawValue,
      kSecAttrAccount: routeId,
      kSecAttrAccessGroup: keychainGroup,
    ]
  }

  /// Updates in place, so the extension never finds a stored route's secret missing.
  func storeSecret(_ secret: RouteSecret, routeId: String, data: Data) throws {
    let query = secretQuery(secret, routeId: routeId)
    let attributes: [CFString: Any] = [
      kSecValueData: data, kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
    ]
    var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw SharedStorageError.keychain(status) }
  }

  func readSecret(_ secret: RouteSecret, routeId: String) throws -> Data {
    var query = secretQuery(secret, routeId: routeId)
    query[kSecReturnData] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else {
      throw SharedStorageError.keychain(status)
    }
    return data
  }

  func deleteSecret(_ secret: RouteSecret, routeId: String) throws {
    let status = SecItemDelete(secretQuery(secret, routeId: routeId) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw SharedStorageError.keychain(status)
    }
  }
}

extension SharedStorage {
  func storeRouteMeta(_ meta: RouteMeta, routeId: String) throws {
    try defaults().set(JSONEncoder().encode(meta), forKey: Self.routeMetaKeyPrefix + routeId)
  }

  func readRouteMeta(routeId: String) throws -> RouteMeta? {
    guard let data = try defaults().data(forKey: Self.routeMetaKeyPrefix + routeId) else {
      return nil
    }
    return try JSONDecoder().decode(RouteMeta.self, from: data)
  }

  func deleteRouteMeta(routeId: String) throws {
    try defaults().removeObject(forKey: Self.routeMetaKeyPrefix + routeId)
  }

  func writeNotificationCounts(_ counts: [NotificationCount]) throws {
    try defaults().set(JSONEncoder().encode(counts), forKey: Self.notificationCountsKey)
  }

  func readNotificationCounts() throws -> [NotificationCount] {
    guard let data = try defaults().data(forKey: Self.notificationCountsKey) else { return [] }
    return try JSONDecoder().decode([NotificationCount].self, from: data)
  }
}

/// The pushed-message queue: one file per message, holding the `pushed` record of
/// `prepare_notification` verbatim, so the extension appends and the app drains without a
/// shared lock. Names start with the Unix milliseconds, so a sorted listing is arrival order.
extension SharedStorage {
  private func pushedMessagesFolder() throws -> URL {
    try container().appendingPathComponent(Self.pushedMessagesFolder, isDirectory: true)
  }

  func appendPushedMessage(_ record: Data) throws {
    let folder = try pushedMessagesFolder()
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let millis = UInt64(Date().timeIntervalSince1970 * 1000)
    let name = "\(millis)-\(UUID().uuidString).json"
    try record.write(to: folder.appendingPathComponent(name), options: .atomic)
  }

  /// Takes every queued record and deletes only the files it read, so a record the extension
  /// writes meanwhile stays for the next drain.
  func drainPushedMessages() throws -> [Data] {
    let folder = try pushedMessagesFolder()
    let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
    let files = names.filter { $0.hasSuffix(".json") }.sorted().map {
      folder.appendingPathComponent($0)
    }
    let taken = files.compactMap { file in (try? Data(contentsOf: file)).map { (file, $0) } }
    for (file, _) in taken {
      try? FileManager.default.removeItem(at: file)
    }
    return taken.map { $0.1 }
  }
}
