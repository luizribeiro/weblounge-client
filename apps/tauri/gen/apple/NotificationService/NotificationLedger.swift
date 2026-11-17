import Foundation

/// The App Group's per-conversation unread counts, which the page writes from the engine and
/// the extension bumps per push the way the service worker's ledger does.
struct NotificationLedger {
  private(set) var counts: [NotificationCount]

  var badge: Int { counts.reduce(0) { $0 + Int($1.count) } }

  func count(tag: String) -> UInt32 {
    entry(tag)?.count ?? 0
  }

  /// A message the conversation was already read past stays uncounted; a message without a
  /// server time can't be compared, so it counts.
  mutating func record(tag: String, messageTime: String?) {
    let current = entry(tag)
    if let marker = current?.readAtMs, let time = messageTime.flatMap(serverTimeMs),
      time <= marker
    {
      return
    }
    replace(
      NotificationCount(
        tag: tag, count: (current?.count ?? 0) + 1, readAtMs: current?.readAtMs))
  }

  /// The conversation was read up to `untilMs` elsewhere. A later marker never moves back, so
  /// the marker in effect is returned for matching delivered notifications.
  @discardableResult
  mutating func markRead(tag: String, untilMs: UInt64) -> UInt64 {
    let marker = max(entry(tag)?.readAtMs ?? 0, untilMs)
    replace(NotificationCount(tag: tag, count: 0, readAtMs: marker))
    return marker
  }

  private func entry(_ tag: String) -> NotificationCount? {
    counts.first { $0.tag == tag }
  }

  private mutating func replace(_ entry: NotificationCount) {
    if let index = counts.firstIndex(where: { $0.tag == entry.tag }) {
      counts[index] = entry
    } else {
      counts.append(entry)
    }
  }
}

private let fractionalTime: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter
}()
private let wholeSecondTime = ISO8601DateFormatter()

/// Milliseconds for a `MARKREAD` reference such as `timestamp=2026-11-16T22:45:00.000Z`.
func readMarkerMs(_ reference: String) -> UInt64? {
  let prefix = "timestamp="
  return serverTimeMs(
    reference.hasPrefix(prefix) ? String(reference.dropFirst(prefix.count)) : reference)
}

/// Whether a delivered notification's `userInfo` is a message the marker has read.
func isRead(_ userInfo: [AnyHashable: Any], tag: String, untilMs: UInt64) -> Bool {
  guard userInfo["conversationTag"] as? String == tag,
    let time = (userInfo["messageTime"] as? String).flatMap(serverTimeMs)
  else { return false }
  return time <= untilMs
}

/// Nil for times before 1970 too, which the App Group's unsigned read markers can't hold.
func serverTimeMs(_ iso8601: String) -> UInt64? {
  guard let date = fractionalTime.date(from: iso8601) ?? wholeSecondTime.date(from: iso8601)
  else { return nil }
  let millis = (date.timeIntervalSince1970 * 1000).rounded()
  return millis >= 0 ? UInt64(millis) : nil
}
