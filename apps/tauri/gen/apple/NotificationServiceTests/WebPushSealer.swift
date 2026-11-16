import CryptoKit
import Foundation

/// A route's keys plus the RFC 8291 encryption a home applies before the relay sees a push.
struct WebPushSealer {
  let privateKey = P256.KeyAgreement.PrivateKey()
  let auth = randomBytes(16)

  var privateKeyPkcs8: Data { privateKey.derRepresentation }

  func seal(_ ircLine: String) throws -> Data {
    let sender = P256.KeyAgreement.PrivateKey()
    let receiverPublic = privateKey.publicKey.x963Representation
    let senderPublic = sender.publicKey.x963Representation
    let shared = try sender.sharedSecretFromKeyAgreement(with: privateKey.publicKey)
    let ikm = shared.hkdfDerivedSymmetricKey(
      using: SHA256.self, salt: auth,
      sharedInfo: Data("WebPush: info\0".utf8) + receiverPublic + senderPublic,
      outputByteCount: 32)
    let salt = randomBytes(16)
    let contentKey = derive(ikm, salt, "Content-Encoding: aes128gcm\0", 16)
    let nonce = derive(ikm, salt, "Content-Encoding: nonce\0", 12)
    let sealed = try AES.GCM.seal(
      Data(ircLine.utf8) + Data([lastRecordDelimiter]), using: contentKey,
      nonce: try AES.GCM.Nonce(data: nonce.withUnsafeBytes { Data($0) }))
    return salt + recordSize + Data([UInt8(senderPublic.count)]) + senderPublic
      + sealed.ciphertext + sealed.tag
  }

  private func derive(_ ikm: SymmetricKey, _ salt: Data, _ info: String, _ count: Int)
    -> SymmetricKey
  {
    HKDF<SHA256>.deriveKey(
      inputKeyMaterial: ikm, salt: salt, info: Data(info.utf8), outputByteCount: count)
  }
}

private let lastRecordDelimiter: UInt8 = 2
private let recordSize = withUnsafeBytes(of: UInt32(4096).bigEndian) { Data($0) }

private func randomBytes(_ count: Int) -> Data {
  Data((0..<count).map { _ in UInt8.random(in: 0...255) })
}
