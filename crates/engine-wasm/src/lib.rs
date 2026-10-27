//! WebAssembly boundary for the weblounge engine.

use wasm_bindgen::prelude::wasm_bindgen;

/// Confirms that the wasm boundary links the engine and papo.
#[must_use]
#[wasm_bindgen]
pub fn engine_linked() -> bool {
    drop(weblounge_engine::client_builder(
        "wss://irc.example.test",
        "weblounge",
    ));
    true
}
