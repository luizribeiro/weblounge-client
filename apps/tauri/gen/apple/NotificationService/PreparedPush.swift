import Foundation

/// The JSON `weblounge_prepare_notification` returns.
enum PrepareOutcome: Decodable, Equatable {
  case prepared(PreparedNotification)
  case failed(FailedStage)

  private enum CodingKeys: String, CodingKey { case outcome, notification, stage }
  private enum Kind: String, Decodable { case prepared, failed }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(Kind.self, forKey: .outcome) {
    case .prepared:
      self = .prepared(try container.decode(PreparedNotification.self, forKey: .notification))
    case .failed: self = .failed(try container.decode(FailedStage.self, forKey: .stage))
    }
  }

  static func decode(_ json: Data) throws -> PrepareOutcome {
    try JSONDecoder().decode(PrepareOutcome.self, from: json)
  }
}

/// A decrypt failure means the route's keys are stale; a parse failure is an unsupported event.
enum FailedStage: String, Decodable, Equatable {
  case decrypt, parse
}

enum PreparedNotification: Decodable, Equatable {
  case visible(VisibleNotification)
  case markread(tag: String, until: String)
  case ping

  private enum CodingKeys: String, CodingKey { case kind, tag, until }
  private enum Kind: String, Decodable { case visible, markread, ping }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(Kind.self, forKey: .kind) {
    case .visible: self = .visible(try VisibleNotification(from: decoder))
    case .markread:
      self = .markread(
        tag: try container.decode(String.self, forKey: .tag),
        until: try container.decode(String.self, forKey: .until))
    case .ping: self = .ping
    }
  }
}

/// `userInfo` holds the fields the page's delivered-notification list reads back as `data`.
struct VisibleNotification: Decodable, Equatable {
  let title: String
  let body: String
  let threadId: String
  let userInfo: [String: String]

  var conversationTag: String? { userInfo["conversationTag"] }
  var messageId: String? { userInfo["messageId"] }
  var messageTime: String? { userInfo["messageTime"] }
}

/// The notification's `pushed` record as JSON for the App Group queue, or nil when it carries
/// none.
func pushedRecord(in json: Data) -> Data? {
  guard
    let outcome = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
    let notification = outcome["notification"] as? [String: Any],
    let pushed = notification["pushed"] as? [String: Any]
  else { return nil }
  return try? JSONSerialization.data(withJSONObject: pushed)
}
