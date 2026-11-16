import CryptoKit
import Foundation
import Security

/// Makes and stores a route's RFC 8291 keys, returning their public half.
struct RouteKeyMaker {
  let storage: SharedStorage

  func create(routeId: String, meta: RouteMeta) throws -> [String: Any] {
    let privateKey = P256.KeyAgreement.PrivateKey()
    let auth = try randomBytes(16)
    do {
      try storage.storeSecret(.privateKeyPkcs8, routeId: routeId, data: privateKey.derRepresentation)
      try storage.storeSecret(.auth, routeId: routeId, data: auth)
      try storage.storeRouteMeta(meta, routeId: routeId)
      try storage.clearReregistrationFlag(routeId: routeId)
    } catch {
      try? drop(routeId: routeId)
      throw BridgeFailure.storage(error)
    }
    return [
      "p256dh": base64url(privateKey.publicKey.x963Representation),
      "auth": base64url(auth),
    ]
  }

  func drop(routeId: String) throws {
    do {
      for secret in RouteSecret.allCases {
        try storage.deleteSecret(secret, routeId: routeId)
      }
      try storage.deleteRouteMeta(routeId: routeId)
      try storage.clearReregistrationFlag(routeId: routeId)
    } catch {
      throw BridgeFailure.storage(error)
    }
  }

  private func randomBytes(_ count: Int) throws -> Data {
    var bytes = [UInt8](repeating: 0, count: count)
    let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
    guard status == errSecSuccess else {
      throw BridgeFailure(.keychain, SharedStorageError.keychain(status))
    }
    return Data(bytes)
  }
}

private func base64url(_ data: Data) -> String {
  data.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}
