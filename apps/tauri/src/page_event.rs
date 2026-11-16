//! Scripts that dispatch the shell's [`PageEvent`]s on the page's `window`.

use serde::Deserialize;
use serde_json::Value;
use weblounge_native_bridge::PageEvent;

#[derive(Deserialize)]
struct NamedDetail {
    name: String,
    detail: Value,
}

pub fn dispatch_script(event: &PageEvent) -> Result<String, serde_json::Error> {
    let NamedDetail { name, detail } = serde_json::from_value(serde_json::to_value(event)?)?;
    Ok(format!(
        "window.dispatchEvent(new CustomEvent({}, {{ detail: {detail} }}));",
        serde_json::to_string(&name)?
    ))
}

#[cfg(test)]
mod tests {
    use weblounge_native_bridge::{AppLifecycle, BufferRoutePath};

    use super::*;

    #[test]
    fn an_open_route_dispatches_the_route_as_its_detail() {
        let route = BufferRoutePath::try_from("/Libera/@mel".to_owned()).expect("valid route");
        assert_eq!(
            dispatch_script(&PageEvent::OpenRoute(route)).expect("script builds"),
            "window.dispatchEvent(new CustomEvent(\"weblounge:open-route\", \
             { detail: \"/Libera/@mel\" }));"
        );
    }

    #[test]
    fn a_lifecycle_change_dispatches_its_side() {
        assert_eq!(
            dispatch_script(&PageEvent::Lifecycle(AppLifecycle::Background))
                .expect("script builds"),
            "window.dispatchEvent(new CustomEvent(\"weblounge:lifecycle\", \
             { detail: \"background\" }));"
        );
    }
}
