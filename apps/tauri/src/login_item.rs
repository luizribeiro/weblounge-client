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

pub fn current(item: &impl LoginItem) -> bool {
    item.is_enabled().unwrap_or_else(|error| {
        eprintln!("{error}");
        false
    })
}

pub fn toggle(item: &impl LoginItem) -> Result<bool, LoginItemError> {
    let wanted = !item.is_enabled()?;
    item.set_enabled(wanted)?;
    item.is_enabled()
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    #[derive(Default)]
    struct FakeLoginItem {
        enabled: Cell<bool>,
        lookup_fails: bool,
        set_fails: bool,
        set_is_ignored: bool,
    }

    fn io_error() -> LoginItemError {
        LoginItemError(tauri_plugin_autostart::Error::Io(std::io::Error::other(
            "LaunchAgents is read-only",
        )))
    }

    impl LoginItem for FakeLoginItem {
        fn is_enabled(&self) -> Result<bool, LoginItemError> {
            if self.lookup_fails {
                return Err(io_error());
            }
            Ok(self.enabled.get())
        }

        fn set_enabled(&self, enabled: bool) -> Result<(), LoginItemError> {
            if self.set_fails {
                return Err(io_error());
            }
            if !self.set_is_ignored {
                self.enabled.set(enabled);
            }
            Ok(())
        }
    }

    #[test]
    fn toggling_a_disabled_item_enables_it() {
        let item = FakeLoginItem::default();
        assert!(toggle(&item).expect("toggle succeeds"));
        assert!(item.enabled.get());
    }

    #[test]
    fn toggling_an_enabled_item_disables_it() {
        let item = FakeLoginItem {
            enabled: Cell::new(true),
            ..FakeLoginItem::default()
        };
        assert!(!toggle(&item).expect("toggle succeeds"));
        assert!(!item.enabled.get());
    }

    #[test]
    fn a_failed_toggle_is_an_error_and_keeps_the_state() {
        let item = FakeLoginItem {
            enabled: Cell::new(true),
            set_fails: true,
            ..FakeLoginItem::default()
        };
        assert!(toggle(&item).is_err());
        assert!(current(&item));
    }

    #[test]
    fn toggle_reports_the_real_state_when_the_system_ignores_the_change() {
        let item = FakeLoginItem {
            set_is_ignored: true,
            ..FakeLoginItem::default()
        };
        assert!(!toggle(&item).expect("toggle succeeds"));
    }

    #[test]
    fn current_is_off_when_the_lookup_fails() {
        let item = FakeLoginItem {
            enabled: Cell::new(true),
            lookup_fails: true,
            ..FakeLoginItem::default()
        };
        assert!(!current(&item));
    }
}
