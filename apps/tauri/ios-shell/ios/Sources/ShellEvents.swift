import Foundation
import Tauri

/// Sends taps and lifecycle changes to the Rust side, holding any that happen before it has
/// subscribed, such as the tap that cold-launched the app. Sending under the lock keeps them in
/// order; the Rust handler never calls back into this class synchronously.
final class ShellEvents {
  private let lock = NSLock()
  private var channel: Channel?
  private var pending: [JsonObject] = []

  func attach(_ channel: Channel) {
    lock.lock()
    defer { lock.unlock() }
    self.channel = channel
    pending.forEach { channel.send($0) }
    pending = []
  }

  func send(_ event: JsonObject) {
    lock.lock()
    defer { lock.unlock() }
    if let channel {
      channel.send(event)
    } else {
      pending.append(event)
    }
  }
}
