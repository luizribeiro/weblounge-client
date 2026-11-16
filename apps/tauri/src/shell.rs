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

const SHELL: Shell = Shell {
    kind: KIND,
    version: env!("CARGO_PKG_VERSION"),
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
    fn identifies_the_crate_version() {
        assert_eq!(parsed_identity()["version"], env!("CARGO_PKG_VERSION"));
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
    fn freezes_the_identity_under_the_page_contract_name() {
        let script = identity_script().expect("script builds");
        assert!(script.starts_with("Object.defineProperty(globalThis, \"__WEBLOUNGE_SHELL__\""));
        assert!(script.contains(&format!("Object.freeze({})", identity().expect("identity"))));
    }
}
