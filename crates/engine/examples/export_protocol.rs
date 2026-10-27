//! Generates the committed TypeScript protocol bindings.

use std::{env, error::Error, fs, path::Path};

use ts_rs::TS;
use weblounge_engine::{EngineToUi, UiToEngine};

fn main() -> Result<(), Box<dyn Error>> {
    let output = env::args_os()
        .nth(1)
        .ok_or("usage: export_protocol <output-directory>")?;

    EngineToUi::export_all_to(&output)?;
    UiToEngine::export_all_to(&output)?;
    trim_trailing_whitespace(Path::new(&output))?;
    Ok(())
}

fn trim_trailing_whitespace(directory: &Path) -> Result<(), Box<dyn Error>> {
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path.is_dir() {
            trim_trailing_whitespace(&path)?;
        } else {
            let source = fs::read_to_string(&path)?;
            let cleaned = source
                .lines()
                .map(str::trim_end)
                .collect::<Vec<_>>()
                .join("\n");
            fs::write(path, format!("{cleaned}\n"))?;
        }
    }
    Ok(())
}
