//! Builds and links the Swift package when compiling for iOS.

const COMMANDS: &[&str] = &[];

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Tauri's builder declares only its own inputs, which would leave Swift edits unbuilt.
    println!("cargo:rerun-if-changed=ios/Package.swift");
    println!("cargo:rerun-if-changed=ios/Sources");
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .try_build()?;
    Ok(())
}
