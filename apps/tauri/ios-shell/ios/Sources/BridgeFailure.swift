import Tauri

/// A failure in one platform subsystem. The code is the bridge's `NativeBridgeError` kind, which
/// the Rust side turns back into that error.
struct BridgeFailure: Error {
  enum Kind: String {
    case apnsRegistration = "apns_registration"
    case keychain
    case appGroup = "app_group"
    case notificationCenter = "notification_center"
  }

  let kind: Kind
  let message: String

  init(_ kind: Kind, _ error: Any) {
    self.kind = kind
    self.message = String(describing: error)
  }
}

extension Invoke {
  func reject(_ failure: BridgeFailure) {
    reject(failure.message, code: failure.kind.rawValue)
  }

  /// Resolves with `work`'s result, or rejects with its failure, tagged `kind` unless it
  /// already is a `BridgeFailure`.
  func settle(_ kind: BridgeFailure.Kind, _ work: () throws -> JsonObject?) {
    do {
      if let result = try work() {
        resolve(result)
      } else {
        resolve()
      }
    } catch let failure as BridgeFailure {
      reject(failure)
    } catch {
      reject(BridgeFailure(kind, error))
    }
  }
}
