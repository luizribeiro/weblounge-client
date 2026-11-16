import ObjectiveC
import UIKit

/// Keeps the status bar legible against the page background. tao's root view controller doesn't
/// override `preferredStatusBarStyle`, so its `.default` would follow the system appearance even
/// under a theme the user chose against it; the shell adds that override to the controller's class.
enum StatusBarStyle {
  private static var current = UIStatusBarStyle.default
  private static var answering = false

  static func follow(_ background: UIColor?, in controller: UIViewController?) {
    current = background.map(style(against:)) ?? .default
    guard let controller else { return }
    answerPreferredStyle(for: type(of: controller))
    controller.setNeedsStatusBarAppearanceUpdate()
  }

  private static func style(against background: UIColor) -> UIStatusBarStyle {
    var red: CGFloat = 0
    var green: CGFloat = 0
    var blue: CGFloat = 0
    guard background.getRed(&red, green: &green, blue: &blue, alpha: nil) else { return .default }
    let luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
    return luminance < 0.5 ? .lightContent : .darkContent
  }

  private static func answerPreferredStyle(for controllerClass: AnyClass) {
    guard !answering else { return }
    answering = true
    let answer: @convention(block) (UIViewController) -> Int = { _ in current.rawValue }
    let added = class_addMethod(
      controllerClass, #selector(getter: UIViewController.preferredStatusBarStyle),
      imp_implementationWithBlock(answer), "q@:")
    assert(added, "\(controllerClass) already answers preferredStatusBarStyle")
  }
}
