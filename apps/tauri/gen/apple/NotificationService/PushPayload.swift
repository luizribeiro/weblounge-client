import Foundation

/// push-payload's C ABI: it decrypts, parses and formats, and this side only moves bytes.
enum PushPayload {
  static func prepare(ciphertext: Data, privateKeyPkcs8: Data, auth: Data, route: RouteMeta)
    -> Data?
  {
    ciphertext.lent { ciphertext in
      privateKeyPkcs8.lent { privateKey in
        auth.lent { auth in
          take(
            weblounge_prepare_notification(
              ciphertext, privateKey, auth, route.networkLabel, route.nickname))
        }
      }
    }
  }

  static func countedBody(_ body: String, count: UInt32, newMessages: String) -> String? {
    take(weblounge_counted_notification_body(body, count, newMessages)).map {
      String(decoding: $0, as: UTF8.self)
    }
  }

  private static func take(_ value: UnsafeMutablePointer<CChar>?) -> Data? {
    guard let value else { return nil }
    defer { weblounge_string_free(value) }
    return Data(bytes: value, count: strlen(value))
  }
}

extension Data {
  fileprivate func lent<T>(_ body: (WebloungeBytes) -> T) -> T {
    withUnsafeBytes { raw in
      body(WebloungeBytes(data: raw.bindMemory(to: UInt8.self).baseAddress, len: raw.count))
    }
  }
}
