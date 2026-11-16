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
    replace(NotificationCount(tag: tag, count: (current?.count ?? 0) + 1, readAtMs: nil))
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

/// Nil for times before 1970 too, which the App Group's unsigned read markers can't hold.
func serverTimeMs(_ iso8601: String) -> UInt64? {
  guard let date = fractionalTime.date(from: iso8601) ?? wholeSecondTime.date(from: iso8601)
  else { return nil }
  let millis = (date.timeIntervalSince1970 * 1000).rounded()
  return millis >= 0 ? UInt64(millis) : nil
}
