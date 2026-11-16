import Tauri

/// The iOS shell's Apple API calls. Each command answers in the bridge's JSON shapes; the Rust
/// side validates every answer into the bridge's types before the page sees it.
final class ShellPlugin: Plugin {}

@_cdecl("init_plugin_weblounge_ios_shell")
func initPlugin() -> Plugin {
  ShellPlugin()
}
