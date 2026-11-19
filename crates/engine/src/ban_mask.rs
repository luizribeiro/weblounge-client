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

/// The masks `/unban <word>` removes: every fetched ban matching the member, or the mask a
/// `/ban` of the same word would have set.
pub(crate) fn unban_masks(
    state: &papo::State,
    channel: Option<&papo::ChannelName>,
    word: &str,
) -> Vec<String> {
    if is_mask(word) {
        return vec![word.to_owned()];
    }
    let user = state.user(word);
    let matching = user
        .and_then(|user| {
            let identity = format!("{}!{}@{}", user.nick(), user.username()?, user.host()?);
            let bans = state.channel(channel?)?.list(papo::ListMode::Ban)?;
            Some(
                bans.iter()
                    .map(|ban| ban.mask.as_str())
                    .filter(|mask| mask_matches(state.casemapping(), mask, &identity))
                    .map(str::to_owned)
                    .collect::<Vec<_>>(),
            )
        })
        .filter(|masks| !masks.is_empty());
    matching.unwrap_or_else(|| vec![derived_ban_mask(word, user.and_then(papo::User::host))])
}

// TODO(papo-0.1): papo compares list entries (`same_list_entry`) but cannot match a mask
// against a user, so the engine globs `*` and `?` itself.
fn mask_matches(casemapping: papo::Casemapping, mask: &str, identity: &str) -> bool {
    let mask = casemapping.fold(mask).chars().collect::<Vec<_>>();
    let identity = casemapping.fold(identity).chars().collect::<Vec<_>>();
    glob_matches(&mask, &identity)
}

fn glob_matches(pattern: &[char], text: &[char]) -> bool {
    let (mut pattern_index, mut text_index) = (0, 0);
    let mut backtrack: Option<(usize, usize)> = None;
    while text_index < text.len() {
        match pattern.get(pattern_index) {
            Some('*') => {
                backtrack = Some((pattern_index, text_index));
                pattern_index += 1;
            }
            Some(&character) if character == '?' || character == text[text_index] => {
                pattern_index += 1;
                text_index += 1;
            }
            _ => {
                let Some((star, matched)) = backtrack else {
                    return false;
                };
                backtrack = Some((star, matched + 1));
                pattern_index = star + 1;
                text_index = matched + 1;
            }
        }
    }
    pattern[pattern_index..]
        .iter()
        .all(|character| *character == '*')
}

#[cfg(test)]
mod tests {
    use super::{derived_ban_mask, is_mask, mask_matches};

    #[test]
    fn masks_match_with_wildcards_and_casemapping() {
        let rfc1459 = papo::Casemapping::Rfc1459;
        for (mask, identity, matches) in [
            ("*!*@mel.host", "mel!m@mel.host", true),
            ("*!*@MEL.HOST", "mel!m@mel.host", true),
            ("mel!*@*", "Mel!m@anywhere", true),
            ("[mel]!*@*", "{mel}!m@host", true),
            ("m?l!*@*", "mel!m@host", true),
            ("*!*@*.example", "mel!m@a.b.example", true),
            ("*!*@other.host", "mel!m@mel.host", false),
            ("iris!*@*", "mel!m@host", false),
            ("mel!*@*.host", "mel!m@host", false),
        ] {
            assert_eq!(
                mask_matches(rfc1459, mask, identity),
                matches,
                "{mask} ~ {identity}"
            );
        }
    }

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
