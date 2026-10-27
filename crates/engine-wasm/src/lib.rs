//! WebAssembly boundary for the worker-owned weblounge engine.

use wasm_bindgen::prelude::{JsValue, wasm_bindgen};
use weblounge_engine::{Engine, UiToEngine};

/// Worker-owned engine handle.
#[wasm_bindgen]
pub struct WasmEngine(Engine);

#[wasm_bindgen]
impl WasmEngine {
    /// Creates one engine for the lifetime of its worker.
    #[must_use]
    #[wasm_bindgen(constructor)]
    pub fn new(build_id: String, instance_id: String) -> Self {
        Self(Engine::new(build_id, instance_id))
    }

    /// Handles one JSON envelope and returns an ordered JSON event array.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript string error when the envelope cannot be decoded or encoded.
    pub fn handle(&self, json: &str) -> Result<String, JsValue> {
        handle_json(&self.0, json).map_err(|error| JsValue::from_str(&error))
    }
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

        assert_eq!(
            super::handle_json(&engine, input).expect("boundary accepts hello"),
            r#"[{"type":"ready","engine_instance":"engine-1","revision":0}]"#
        );
    }

    #[test]
    fn json_boundary_rejects_invalid_envelopes() {
        let engine = Engine::new("build-1", "engine-1");

        assert!(super::handle_json(&engine, "{}").is_err());
    }
}
