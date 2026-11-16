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

  /// The outcome with the JSON it was decoded from, or nil when the route's keys or metadata
  /// are gone, as after the page dropped the route.
  func prepare(_ storage: SharedStorage) -> (outcome: PrepareOutcome, json: Data)? {
    guard let route = try? storage.readRouteMeta(routeId: routeId),
      let privateKey = try? storage.readSecret(.privateKeyPkcs8, routeId: routeId),
      let auth = try? storage.readSecret(.auth, routeId: routeId),
      let json = PushPayload.prepare(
        ciphertext: ciphertext, privateKeyPkcs8: privateKey, auth: auth, route: route),
      let outcome = try? PrepareOutcome.decode(json)
    else { return nil }
    return (outcome, json)
  }
}
