/// Characters that cannot appear in a nick, so a word holding one is already a mask or extban.
const MASK_CHARACTERS: [char; 5] = ['!', '@', '*', '?', ':'];

pub(crate) fn is_mask(word: &str) -> bool {
    word.contains(MASK_CHARACTERS)
}

/// The mask common clients ban by default: the member's host, or the nick alone while the host
/// is unknown.
pub(crate) fn derived_ban_mask(nick: &str, host: Option<&str>) -> String {
    host.map_or_else(|| format!("{nick}!*@*"), |host| format!("*!*@{host}"))
}

/// The mask a `/ban` word stands for in the current network state.
pub(crate) fn ban_mask(state: &papo::State, word: &str) -> String {
    if is_mask(word) {
        return word.to_owned();
    }
    derived_ban_mask(word, state.user(word).and_then(papo::User::host))
}

#[cfg(test)]
mod tests {
    use super::{derived_ban_mask, is_mask};

    #[test]
    fn words_with_mask_characters_are_masks() {
        for mask in [
            "*!*@spam.example",
            "mel!*@*",
            "m:*!*@host",
            "$a:mel",
            "spam?",
        ] {
            assert!(is_mask(mask), "{mask}");
        }
        for nick in ["mel", "Mel_", "[away]mel", "mel-phone"] {
            assert!(!is_mask(nick), "{nick}");
        }
    }

    #[test]
    fn a_nick_becomes_its_host_mask_or_its_nick_mask() {
        assert_eq!(
            derived_ban_mask("mel", Some("mel.host.example")),
            "*!*@mel.host.example"
        );
        assert_eq!(derived_ban_mask("mel", None), "mel!*@*");
    }
}
