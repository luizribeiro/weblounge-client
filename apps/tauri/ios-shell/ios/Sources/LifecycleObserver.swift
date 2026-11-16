import UIKit

/// Reports foreground and background to the Rust side. iOS may suspend the app before WebKit
/// delivers `pagehide`, so backgrounding holds a background task until the Rust side has run the
/// page's handler and ends it.
final class LifecycleObserver {
  private let events: ShellEvents

  init(events: ShellEvents) {
    self.events = events
  }

  func start() {
    let center = NotificationCenter.default
    center.addObserver(
      self, selector: #selector(didEnterBackground),
      name: UIApplication.didEnterBackgroundNotification, object: nil)
    center.addObserver(
      self, selector: #selector(willEnterForeground),
      name: UIApplication.willEnterForegroundNotification, object: nil)
  }

  @objc private func didEnterBackground() {
    var task = UIBackgroundTaskIdentifier.invalid
    task = UIApplication.shared.beginBackgroundTask(withName: "weblounge:lifecycle") {
      UIApplication.shared.endBackgroundTask(task)
    }
    var event: [String: Any?] = ["kind": "lifecycle", "side": "background"]
    if task != .invalid { event["backgroundTask"] = task.rawValue }
    events.send(event)
  }

  @objc private func willEnterForeground() {
    events.send(["kind": "lifecycle", "side": "foreground"])
  }

  static func endBackgroundTask(_ rawValue: Int) {
    UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: rawValue))
  }
}
