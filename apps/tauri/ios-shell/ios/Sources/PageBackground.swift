import UIKit
import WebKit

/// Reports each page's background colour, or `nil` when the page paints none of its own: when a
/// document loads, when the app's theme changes, and when the system appearance flips under a
/// `light dark` page. It reads the computed colour in the page because `underPageBackgroundColor`
/// stays white in this transparent web view.
final class PageBackground: NSObject, WKScriptMessageHandler {
  private static let handlerName = "webloungePageBackground"
  // An isolated world keeps the handler and the watcher out of reach of the hosted pages.
  private static let world = WKContentWorld.defaultClient
  private let onChange: (UIColor?) -> Void

  init(onChange: @escaping (UIColor?) -> Void) {
    self.onChange = onChange
  }

  func watch(_ webview: WKWebView) {
    let controller = webview.configuration.userContentController
    controller.add(self, contentWorld: Self.world, name: Self.handlerName)
    controller.addUserScript(
      WKUserScript(
        source: Self.watcher, injectionTime: .atDocumentEnd, forMainFrameOnly: true,
        in: Self.world))
    // The first document may have started loading before the script was registered.
    webview.evaluateJavaScript(Self.watcher, in: nil, in: Self.world) { _ in }
  }

  func userContentController(
    _ controller: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard let channels = message.body as? [NSNumber], channels.count == 4 else {
      onChange(nil)
      return
    }
    let unit = channels.map { CGFloat($0.doubleValue) / 255 }
    onChange(UIColor(red: unit[0], green: unit[1], blue: unit[2], alpha: unit[3]))
  }

  // Drawing the computed colour into a pixel turns any CSS colour syntax into sRGB bytes.
  private static let watcher = """
    (() => {
      if (window.__webloungePageBackground || !document.documentElement) return;
      window.__webloungePageBackground = true;
      const context = Object.assign(document.createElement("canvas"), { width: 1, height: 1 })
        .getContext("2d", { willReadFrequently: true });
      const painted = (color) => color !== "" && color !== "rgba(0, 0, 0, 0)";
      const bytes = (color) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data);
      };
      let reported;
      const report = () => {
        const color = [document.documentElement, document.body]
          .map((element) => (element ? getComputedStyle(element).backgroundColor : ""))
          .find(painted) ?? null;
        if (color === reported) return;
        reported = color;
        window.webkit.messageHandlers.\(handlerName).postMessage(color && bytes(color));
      };
      new MutationObserver(report).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", report);
      if (document.readyState === "loading") {
        addEventListener("DOMContentLoaded", report, { once: true });
      }
      report();
    })();
    """
}
