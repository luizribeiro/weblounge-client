//! How the process was started.

pub const HIDDEN_ARG: &str = "--hidden";

pub fn starts_hidden(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().any(|arg| arg == HIDDEN_ARG)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn the_login_item_argument_starts_hidden() {
        assert!(starts_hidden(args(&[
            "/Applications/Weblounge.app/Contents/MacOS/weblounge-desktop",
            "--hidden"
        ])));
    }

    #[test]
    fn a_normal_launch_shows_the_window() {
        assert!(!starts_hidden(args(&[
            "/Applications/Weblounge.app/Contents/MacOS/weblounge-desktop"
        ])));
        assert!(!starts_hidden(args(&["weblounge-desktop", "--hidden-ish"])));
    }
}
