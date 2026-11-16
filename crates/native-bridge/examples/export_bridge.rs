//! Generates the committed TypeScript bindings for the page's native bridge.

use std::{env, error::Error, path::Path};

use ts_rs::TS;
use weblounge_native_bridge::NativeCommand;

fn main() -> Result<(), Box<dyn Error>> {
    let output = env::args_os()
        .nth(1)
        .ok_or("usage: export_bridge <output-directory>")?;

    NativeCommand::export_all_to(&output)?;
    weblounge_ts_export::trim_trailing_whitespace(Path::new(&output))?;
    Ok(())
}
