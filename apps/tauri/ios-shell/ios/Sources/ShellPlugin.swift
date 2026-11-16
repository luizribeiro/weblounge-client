import Tauri
import UserNotifications

struct WatchEventsArgs: Decodable { let handler: Channel }

/// The iOS shell's Apple API calls. Each command answers in the bridge's JSON shapes; the Rust
/// side validates every answer into the bridge's types before the page sees it.
final class ShellPlugin: Plugin {
  private let events = ShellEvents()
  private lazy var routing = NotificationRouting(events: events)
  private var center: UNUserNotificationCenter { .current() }

  override init() {
    super.init()
    center.delegate = routing
  }

  @objc func watchEvents(_ invoke: Invoke) {
    invoke.settle(.notificationCenter) {
      events.attach(try invoke.parseArgs(WatchEventsArgs.self).handler)
      return nil
    }
  }

  @objc func pushPermission(_ invoke: Invoke) {
    center.getNotificationSettings { settings in
      switch settings.authorizationStatus {
      case .authorized, .provisional, .ephemeral: invoke.resolve("granted")
      case .denied: invoke.resolve("denied")
      case .notDetermined: invoke.resolve("default")
      @unknown default: invoke.resolve("default")
      }
    }
  }
}

@_cdecl("init_plugin_weblounge_ios_shell")
func initPlugin() -> Plugin {
  ShellPlugin()
}
