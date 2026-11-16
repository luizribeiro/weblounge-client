import Foundation
import ObjectiveC
import UIKit

/// Holds the APNs device token. tao declares the app's `AppDelegate` class at runtime without the
/// remote-notification callbacks and panics if another class of that name exists, so the
/// callbacks are added to tao's class.
final class RemoteNotificationRegistration {
  enum State {
    case unknown
    case token(Data)
    case failed(BridgeFailure)
  }

  private let lock = NSLock()
  private var state = State.unknown
  private let tokenChanged: (Data) -> Void

  init(tokenChanged: @escaping (Data) -> Void) {
    self.tokenChanged = tokenChanged
  }

  func install() {
    guard let delegate = NSClassFromString("AppDelegate") else {
      NSLog("weblounge: no AppDelegate class to receive the APNs token")
      return
    }
    let registered: @convention(block) (AnyObject, UIApplication, Data) -> Void = {
      [weak self] _, _, token in self?.received(token)
    }
    let failed: @convention(block) (AnyObject, UIApplication, NSError) -> Void = {
      [weak self] _, _, error in
      self?.update(.failed(BridgeFailure(.apnsRegistration, error.localizedDescription)))
    }
    add(
      #selector(UIApplicationDelegate.application(_:didRegisterForRemoteNotificationsWithDeviceToken:)),
      registered, to: delegate)
    add(
      #selector(UIApplicationDelegate.application(_:didFailToRegisterForRemoteNotificationsWithError:)),
      failed, to: delegate)
  }

  private func add(_ selector: Selector, _ block: Any, to delegate: AnyClass) {
    if !class_addMethod(delegate, selector, imp_implementationWithBlock(block), "v@:@@") {
      NSLog("weblounge: AppDelegate already implements \(selector)")
    }
  }

  /// The token or the last registration failure; registers again unless a token is known.
  func current() -> State {
    lock.lock()
    let current = state
    if case .failed = state { state = .unknown }
    lock.unlock()
    if case .token = current {} else { register() }
    return current
  }

  func register() {
    DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
  }

  private func received(_ token: Data) {
    let previous = update(.token(token))
    if case .token(token) = previous { return }
    tokenChanged(token)
  }

  @discardableResult
  private func update(_ next: State) -> State {
    lock.lock()
    defer { lock.unlock() }
    let previous = state
    state = next
    return previous
  }
}
