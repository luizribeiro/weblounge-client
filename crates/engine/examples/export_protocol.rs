//! Generates the committed TypeScript protocol bindings.

use std::{env, error::Error, fs, path::Path};

use ts_rs::TS;
use weblounge_engine::{
    DeploymentConfig, EngineMessageKey, EngineToUi, UiToEngine,
    storage::{WEB_DATABASE_NAME, WEB_DATABASE_STORES, WEB_DATABASE_VERSION},
};

fn main() -> Result<(), Box<dyn Error>> {
    let output = env::args_os()
        .nth(1)
        .ok_or("usage: export_protocol <output-directory>")?;

    EngineToUi::export_all_to(&output)?;
    UiToEngine::export_all_to(&output)?;
    DeploymentConfig::export_all_to(&output)?;
    export_engine_message_keys(Path::new(&output))?;
    export_database_schema(Path::new(&output))?;
    weblounge_ts_export::trim_trailing_whitespace(Path::new(&output))?;
    Ok(())
}

fn export_engine_message_keys(directory: &Path) -> Result<(), Box<dyn Error>> {
    let keys = EngineMessageKey::ALL
        .iter()
        .map(|key| format!("{:?}", key.as_str()))
        .collect::<Vec<_>>()
        .join(",\n  ");
    fs::write(
        directory.join("EngineMessageKeys.ts"),
        format!(
            "// Generated from the engine's localization key enum. Do not edit manually.\n\
             export const ENGINE_MESSAGE_KEYS = [\n  {keys},\n] as const;\n"
        ),
    )?;
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
