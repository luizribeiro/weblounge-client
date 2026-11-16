import Foundation

extension Data {
  /// Decodes unpadded base64url, the relay's encoding for the record.
  init?(base64URLEncoded text: String) {
    var base64 = text.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.utf8.count % 4) % 4)
    self.init(base64Encoded: base64)
  }
}
