import Foundation

/// The relay's APNs payload: the route id (`r`) and the home's encrypted record (`c`, base64url).
struct RelayPush {
  let routeId: String
  let ciphertext: Data

  init?(_ userInfo: [AnyHashable: Any]) {
    guard let routeId = userInfo["r"] as? String, let encoded = userInfo["c"] as? String,
      let ciphertext = Data(base64URLEncoded: encoded)
    else { return nil }
    self.routeId = routeId
    self.ciphertext = ciphertext
  }

  /// Nil when the route's keys or metadata are gone, as after the page dropped the route.
  func prepare(_ storage: SharedStorage) -> PrepareOutcome? {
    guard let route = try? storage.readRouteMeta(routeId: routeId),
      let privateKey = try? storage.readSecret(.privateKeyPkcs8, routeId: routeId),
      let auth = try? storage.readSecret(.auth, routeId: routeId),
      let json = PushPayload.prepare(
        ciphertext: ciphertext, privateKeyPkcs8: privateKey, auth: auth, route: route)
    else { return nil }
    return try? PrepareOutcome.decode(json)
  }
}
