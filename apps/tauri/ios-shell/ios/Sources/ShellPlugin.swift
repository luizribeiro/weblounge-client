import Foundation
import Tauri
import UIKit
import UserNotifications
import WebKit

struct WatchEventsArgs: Decodable { let handler: Channel }
struct EndBackgroundTaskArgs: Decodable { let id: Int }
struct CreateRouteKeysArgs: Decodable {
  let routeId: String
  let route: RouteMeta
}
struct RouteIdArgs: Decodable { let routeId: String }
struct SetBadgeArgs: Decodable { let count: Int }
struct WriteNotificationCountsArgs: Decodable { let counts: [NotificationCount] }
struct IdentifiersArgs: Decodable { let identifiers: [String] }

/// The iOS shell's Apple API calls. Each command answers in the bridge's JSON shapes; the Rust
/// side validates every answer into the bridge's types before the page sees it.
final class ShellPlugin: Plugin {
  private let events = ShellEvents()
  private lazy var registration = RemoteNotificationRegistration { [events] token in
    events.send(registrationAnswer(token).merging(["kind": "token"]) { current, _ in current })
  }
  private lazy var routing = NotificationRouting(events: events)
  private lazy var lifecycle = LifecycleObserver(events: events)
  private var center: UNUserNotificationCenter { .current() }

  override init() {
    super.init()
    registration.install()
    center.delegate = routing
    lifecycle.start()
  }

  override func load(webview: WKWebView) {
    // The web view's own background shows wherever the page doesn't paint: the band WebKit
    // insets a page without `viewport-fit=cover` by, and the first frames of a reload.
    PageBackground { [weak webview] color in
      webview?.backgroundColor = color ?? .systemBackground
      StatusBarStyle.follow(color, in: webview?.window?.rootViewController)
    }.watch(webview)
  }

  @objc func watchEvents(_ invoke: Invoke) {
    invoke.settle(.notificationCenter) {
      events.attach(try invoke.parseArgs(WatchEventsArgs.self).handler)
      return nil
    }
  }

  @objc func endBackgroundTask(_ invoke: Invoke) {
    invoke.settle(.notificationCenter) {
      LifecycleObserver.endBackgroundTask(try invoke.parseArgs(EndBackgroundTaskArgs.self).id)
      return nil
    }
  }

  @objc func requestPushPermission(_ invoke: Invoke) {
    center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
      if let error {
        invoke.reject(BridgeFailure(.notificationCenter, error.localizedDescription))
        return
      }
      if granted { self.registration.register() }
      invoke.resolve(granted ? "granted" : "denied")
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

  @objc func pushTarget(_ invoke: Invoke) {
    switch registration.current() {
    case .unknown: invoke.resolve(Optional<String>.none)
    case .failed(let failure): invoke.reject(failure)
    case .token(let token): invoke.resolve(registrationAnswer(token))
    }
  }

  @objc func createRouteKeys(_ invoke: Invoke) {
    invoke.settle(.keychain) {
      let args = try invoke.parseArgs(CreateRouteKeysArgs.self)
      return try RouteKeyMaker(storage: try storage()).create(routeId: args.routeId, meta: args.route)
    }
  }

  @objc func dropRouteKeys(_ invoke: Invoke) {
    invoke.settle(.keychain) {
      let args = try invoke.parseArgs(RouteIdArgs.self)
      try RouteKeyMaker(storage: try storage()).drop(routeId: args.routeId)
      return nil
    }
  }

  @objc func routesNeedingReregistration(_ invoke: Invoke) {
    invoke.settle(.appGroup) { ["routeIds": try storage().routesNeedingReregistration()] }
  }

  @objc func takePushedMessages(_ invoke: Invoke) {
    invoke.settle(.appGroup) {
      let records = try storage().drainPushedMessages()
      return ["messages": records.compactMap { try? JSONSerialization.jsonObject(with: $0) }]
    }
  }

  @objc func writeNotificationCounts(_ invoke: Invoke) {
    invoke.settle(.appGroup) {
      let args = try invoke.parseArgs(WriteNotificationCountsArgs.self)
      try storage().writeNotificationCounts(args.counts)
      return nil
    }
  }

  @objc func setBadge(_ invoke: Invoke) {
    do {
      let args = try invoke.parseArgs(SetBadgeArgs.self)
      center.setBadgeCount(args.count) { error in
        if let error {
          invoke.reject(BridgeFailure(.notificationCenter, error.localizedDescription))
        } else {
          invoke.resolve()
        }
      }
    } catch {
      invoke.reject(BridgeFailure(.notificationCenter, error))
    }
  }

  @objc func deliveredNotifications(_ invoke: Invoke) {
    center.getDeliveredNotifications { notifications in
      invoke.resolve([
        "notifications": notifications.map {
          [
            "identifier": $0.request.identifier,
            "userInfo": jsonUserInfo($0.request.content.userInfo),
          ]
        }
      ])
    }
  }

  @objc func removeDeliveredNotifications(_ invoke: Invoke) {
    invoke.settle(.notificationCenter) {
      let args = try invoke.parseArgs(IdentifiersArgs.self)
      center.removeDeliveredNotifications(withIdentifiers: args.identifiers)
      return nil
    }
  }

  private func storage() throws -> SharedStorage {
    do {
      return try SharedStorage.fromInfoPlist()
    } catch {
      throw BridgeFailure(.appGroup, error)
    }
  }
}

#if targetEnvironment(simulator)
  private let isSimulator = true
#else
  private let isSimulator = false
#endif

/// The token with what decides its APNs host, which the Rust side turns into a `PushTarget`.
private func registrationAnswer(_ token: Data) -> [String: Any?] {
  [
    "token": token.map { String(format: "%02x", $0) }.joined(),
    "simulator": isSimulator,
    "profileApsEnvironment": ProvisioningProfile.apsEnvironment() ?? NSNull(),
  ]
}

@_cdecl("init_plugin_weblounge_ios_shell")
func initPlugin() -> Plugin {
  ShellPlugin()
}
