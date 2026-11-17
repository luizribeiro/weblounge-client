//! The wrapper's identity, published to the page so it can pick native keymaps. Any page script
//! could forge it, so the page must never base a security decision on it.

use serde::Serialize;

const GLOBAL: &str = "__WEBLOUNGE_SHELL__";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Shell {
    kind: &'static str,
    version: &'static str,
    #[cfg(target_os = "macos")]
    window_controls: crate::window::title_bar::WindowControls,
}

#[cfg(target_os = "macos")]
const KIND: &str = "macos-app";
#[cfg(target_os = "ios")]
const KIND: &str = "ios-app";

// Tauri passes only `TAURI_`-prefixed variables through Xcode to the iOS build.
const GIVEN_VERSION: Option<&str> = option_env!("TAURI_WEBLOUNGE_VERSION");

const fn shell_version(given: Option<&'static str>) -> &'static str {
    match given {
        Some(version) if !version.is_empty() => version,
        _ => "dev",
    }
}

const SHELL: Shell = Shell {
    kind: KIND,
    version: shell_version(GIVEN_VERSION),
    #[cfg(target_os = "macos")]
    window_controls: crate::window::title_bar::WINDOW_CONTROLS,
};

fn identity() -> Result<String, serde_json::Error> {
    serde_json::to_string(&SHELL)
}

pub fn identity_script() -> Result<String, serde_json::Error> {
    Ok(format!(
        "Object.defineProperty(globalThis, \"{GLOBAL}\", {{ value: Object.freeze({}) }});",
        identity()?
    ))
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    #[test]
    fn identifies_the_version_the_build_was_given() {
        assert_eq!(parsed_identity()["version"], shell_version(GIVEN_VERSION));
    }

    #[test]
    fn a_release_build_shows_its_describe_style_version() {
        assert_eq!(shell_version(Some("0.2.0+3")), "0.2.0+3");
    }

    #[test]
    fn a_build_given_no_version_is_dev() {
        assert_eq!(shell_version(None), "dev");
        assert_eq!(shell_version(Some("")), "dev");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn identifies_the_macos_app() {
        assert_eq!(parsed_identity()["kind"], "macos-app");
    }

    #[cfg(target_os = "ios")]
    #[test]
    fn identifies_the_ios_app_without_window_controls() {
        let identity = parsed_identity();
        assert_eq!(identity["kind"], "ios-app");
        assert!(identity.get("windowControls").is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reserves_the_traffic_light_band_for_the_page() {
        assert_eq!(
            parsed_identity()["windowControls"],
            serde_json::json!({ "inlineStart": 84, "blockSize": 48 })
        );
    }

    fn parsed_identity() -> Value {
        serde_json::from_str(&identity().expect("identity serializes")).expect("JSON")
    }

    #[test]
    fn cargo_builds_the_swift_plugin_for_the_bundles_minimum_ios() {
        let overlay: Value =
            serde_json::from_str(include_str!("../tauri.ios.conf.json")).expect("config is JSON");
        let minimum = overlay["bundle"]["iOS"]["minimumSystemVersion"]
            .as_str()
            .expect("a minimum iOS version");
        assert!(
            include_str!("../.cargo/config.toml")
                .contains(&format!("IPHONEOS_DEPLOYMENT_TARGET = \"{minimum}\""))
        );
    }

    #[test]
    fn freezes_the_identity_under_the_page_contract_name() {
        let script = identity_script().expect("script builds");
        assert!(script.starts_with("Object.defineProperty(globalThis, \"__WEBLOUNGE_SHELL__\""));
        assert!(script.contains(&format!("Object.freeze({})", identity().expect("identity"))));
    }
}
