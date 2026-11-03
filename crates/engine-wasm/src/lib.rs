//! WebAssembly boundary for the worker-owned weblounge engine.

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
use std::rc::Rc;

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
use js_sys::Function;
use wasm_bindgen::prelude::{JsValue, wasm_bindgen};
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
use weblounge_engine::storage::{KvBackend, Space, WebKv};
use weblounge_engine::{Engine, UiToEngine};

/// Worker-owned engine handle.
#[wasm_bindgen]
pub struct WasmEngine(Engine);

#[wasm_bindgen]
impl WasmEngine {
    /// Handles one JSON envelope and returns an ordered JSON event array.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript string error when the envelope cannot be decoded or encoded.
    pub fn handle(&self, json: &str) -> Result<String, JsValue> {
        handle_json(&self.0, json).map_err(|error| JsValue::from_str(&error))
    }
}

/// Opens worker-owned cache storage and creates one engine for the worker lifetime.
/// IndexedDB failures degrade to an empty in-memory cache.
#[wasm_bindgen]
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub async fn create_wasm_engine(
    build_id: String,
    instance_id: String,
    build_version: String,
    on_event: Function,
) -> Result<WasmEngine, JsValue> {
    let storage = Rc::new(WebKv::open().await);
    let cached_snapshot = storage
        .get(Space::Cache, b"chat-list-snapshot")
        .await
        .unwrap_or(None);
    let cached_pushed_messages = weblounge_engine::load_pushed_messages(storage.as_ref())
        .await
        .unwrap_or_default();
    let (engine, mut events) = Engine::with_events_and_storage(
        build_id,
        instance_id,
        build_version,
        storage,
        cached_snapshot,
        cached_pushed_messages,
    );
    wasm_bindgen_futures::spawn_local(async move {
        while let Some(event) = events.recv().await {
            if let Ok(encoded) = serde_json::to_string(&event) {
                let _ = on_event.call1(&JsValue::NULL, &JsValue::from_str(&encoded));
            }
        }
    });
    Ok(WasmEngine(engine))
}

fn handle_json(engine: &Engine, json: &str) -> Result<String, String> {
    let message = serde_json::from_str::<UiToEngine>(json).map_err(|error| error.to_string())?;
    serde_json::to_string(&engine.handle(message)).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use weblounge_engine::Engine;

    #[test]
    fn json_boundary_returns_ready() {
        let engine = Engine::new("build-1", "engine-1");
        let input = r#"{"type":"hello","payload":{"build_id":"build-1","client_id":"tab-1","last_revision":null,"shell":"web"}}"#;
        let output = super::handle_json(&engine, input).expect("boundary accepts hello");
        let events: serde_json::Value = serde_json::from_str(&output).expect("boundary emits JSON");

        assert_eq!(
            events[0],
            serde_json::json!({
                "type": "ready",
                "engine_instance": "engine-1",
                "revision": 0,
            })
        );
        assert_eq!(events[1]["type"], "command_specs_changed");
        assert!(
            events[1]["specs"]
                .as_array()
                .is_some_and(|specs| !specs.is_empty())
        );
    }

    #[test]
    fn json_boundary_rejects_invalid_envelopes() {
        let engine = Engine::new("build-1", "engine-1");

        assert!(super::handle_json(&engine, "{}").is_err());
    }
}
