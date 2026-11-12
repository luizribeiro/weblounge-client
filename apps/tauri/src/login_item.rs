//! Start-at-login state, behind a seam so the toggle logic is testable without a launch agent.

use tauri_plugin_autostart::{AutoLaunchManager, MacosLauncher};

#[derive(Debug, thiserror::Error)]
#[error("could not change Open at Login: {0}")]
pub struct LoginItemError(#[from] tauri_plugin_autostart::Error);

pub trait LoginItem {
    fn is_enabled(&self) -> Result<bool, LoginItemError>;
    fn set_enabled(&self, enabled: bool) -> Result<(), LoginItemError>;
}

impl LoginItem for AutoLaunchManager {
    fn is_enabled(&self) -> Result<bool, LoginItemError> {
        Ok(AutoLaunchManager::is_enabled(self)?)
    }

    fn set_enabled(&self, enabled: bool) -> Result<(), LoginItemError> {
        if enabled {
            Ok(self.enable()?)
        } else {
            Ok(self.disable()?)
        }
    }
}

pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_autostart::Builder::new()
        .macos_launcher(MacosLauncher::LaunchAgent)
        .build()
}

/// The real state, with a failed lookup logged and shown as off.
pub fn current(item: &impl LoginItem) -> bool {
    item.is_enabled().unwrap_or_else(|error| {
        eprintln!("{error}");
        false
    })
}

/// Flips the login item and returns the state it is really in afterwards.
pub fn toggle(item: &impl LoginItem) -> Result<bool, LoginItemError> {
    let wanted = !item.is_enabled()?;
    item.set_enabled(wanted)?;
    item.is_enabled()
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    struct FakeLoginItem {
        enabled: Cell<bool>,
        fails: bool,
    }

    impl FakeLoginItem {
        fn new(enabled: bool, fails: bool) -> Self {
            Self {
                enabled: Cell::new(enabled),
                fails,
            }
        }
    }

    impl LoginItem for FakeLoginItem {
        fn is_enabled(&self) -> Result<bool, LoginItemError> {
            Ok(self.enabled.get())
        }

        fn set_enabled(&self, enabled: bool) -> Result<(), LoginItemError> {
            if self.fails {
                return Err(LoginItemError(tauri_plugin_autostart::Error::Io(
                    std::io::Error::other("LaunchAgents is read-only"),
                )));
            }
            self.enabled.set(enabled);
            Ok(())
        }
    }

    #[test]
    fn toggling_a_disabled_item_enables_it() {
        let item = FakeLoginItem::new(false, false);
        assert!(toggle(&item).expect("toggle succeeds"));
        assert!(item.enabled.get());
    }

    #[test]
    fn toggling_an_enabled_item_disables_it() {
        let item = FakeLoginItem::new(true, false);
        assert!(!toggle(&item).expect("toggle succeeds"));
        assert!(!item.enabled.get());
    }

    #[test]
    fn a_failed_toggle_leaves_the_state_unchanged() {
        let item = FakeLoginItem::new(false, true);
        assert!(toggle(&item).is_err());
        assert!(!item.enabled.get());
    }
}
