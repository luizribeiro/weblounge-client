//! Generates the committed TypeScript protocol bindings.

use std::{env, error::Error, fs, path::Path};

use ts_rs::TS;
use weblounge_engine::{
    DeploymentConfig, EngineToUi, UiToEngine,
    storage::{WEB_DATABASE_NAME, WEB_DATABASE_STORES, WEB_DATABASE_VERSION},
};

fn main() -> Result<(), Box<dyn Error>> {
    let output = env::args_os()
        .nth(1)
        .ok_or("usage: export_protocol <output-directory>")?;

    EngineToUi::export_all_to(&output)?;
    UiToEngine::export_all_to(&output)?;
    DeploymentConfig::export_all_to(&output)?;
    export_database_schema(Path::new(&output))?;
    trim_trailing_whitespace(Path::new(&output))?;
    Ok(())
}

fn export_database_schema(directory: &Path) -> Result<(), Box<dyn Error>> {
    let stores = WEB_DATABASE_STORES
        .iter()
        .map(|store| format!("{store:?}"))
        .collect::<Vec<_>>()
        .join(", ");
    fs::write(
        directory.join("EngineDatabaseSchema.ts"),
        format!(
            "// Generated from the engine's IndexedDB schema. Do not edit manually.\n\
             export const ENGINE_DATABASE_NAME = {WEB_DATABASE_NAME:?};\n\
             export const ENGINE_DATABASE_VERSION = {WEB_DATABASE_VERSION};\n\
             export const ENGINE_DATABASE_STORES = [{stores}] as const;\n"
        ),
    )?;
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
