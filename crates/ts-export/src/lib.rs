//! Shared finishing step for the examples that write committed TypeScript bindings.

use std::{fs, io, path::Path};

/// Rewrites every file under `directory` the way the whitespace pre-commit hooks would leave
/// it, because ts-rs output has trailing spaces and no final newline and the committed copies
/// pass through those hooks.
///
/// # Errors
///
/// Fails when a file under `directory` can't be read or written.
pub fn trim_trailing_whitespace(directory: &Path) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path.is_dir() {
            trim_trailing_whitespace(&path)?;
        } else {
            let source = fs::read_to_string(&path)?;
            fs::write(path, trimmed(&source))?;
        }
    }
    Ok(())
}

fn trimmed(source: &str) -> String {
    let cleaned = source
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    format!("{cleaned}\n")
}

#[cfg(test)]
mod tests {
    use std::{fs, process};

    use super::{trim_trailing_whitespace, trimmed};

    #[test]
    fn crlf_line_endings_become_newlines() {
        assert_eq!(
            trimmed("export type BufferId = number; \r\nexport type NetworkId = number;\r\n"),
            "export type BufferId = number;\nexport type NetworkId = number;\n"
        );
    }

    #[test]
    fn trims_every_line_and_ends_each_nested_file_with_a_newline() {
        let root = std::env::temp_dir().join(format!("weblounge-ts-export-{}", process::id()));
        let _ = fs::remove_dir_all(&root);
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("creates directories");
        fs::write(
            root.join("PushRoute.ts"),
            "export type PushRoute = { \nroute_id: string, };",
        )
        .expect("writes top-level file");
        fs::write(
            nested.join("BufferId.ts"),
            "export type BufferId = number;  ",
        )
        .expect("writes nested file");

        trim_trailing_whitespace(&root).expect("trims");

        let top = fs::read_to_string(root.join("PushRoute.ts")).expect("reads top-level file");
        let inner = fs::read_to_string(nested.join("BufferId.ts")).expect("reads nested file");
        fs::remove_dir_all(&root).expect("cleans up");
        assert_eq!(top, "export type PushRoute = {\nroute_id: string, };\n");
        assert_eq!(inner, "export type BufferId = number;\n");
    }

    #[test]
    fn a_missing_directory_is_an_error() {
        let missing = std::env::temp_dir().join("weblounge-ts-export-missing-directory");
        assert!(trim_trailing_whitespace(&missing).is_err());
    }
}
