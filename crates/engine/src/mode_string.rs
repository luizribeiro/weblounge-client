use papo_proto::{Advertised, Isupport, ModeAction, ModeChanges, ModeKind};

use crate::EngineMessageKey;

/// One change from a typed `/mode` string, classified by the server's advertised modes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TypedModeChange {
    pub(crate) set: bool,
    pub(crate) mode: char,
    pub(crate) member_mode: bool,
    pub(crate) argument: Option<String>,
}

/// Splits `+o-v mel iris` into changes, refusing letters the server never advertised and
/// changes missing their argument before anything reaches the wire.
pub(crate) fn parse_mode_string(
    semantics: &Isupport,
    text: &str,
) -> Result<Vec<TypedModeChange>, EngineMessageKey> {
    let mut words = text.split_whitespace();
    let modes = words
        .next()
        .ok_or(EngineMessageKey::ComposerMissingArgument)?;
    let arguments = words.collect::<Vec<_>>();
    let changes = ModeChanges::parse(modes, arguments.iter().copied(), semantics)
        .map(|change| {
            let set = change.action == ModeAction::Add;
            let needs_argument = match change.kind {
                ModeKind::Unknown => return Err(EngineMessageKey::ModeUnknown),
                ModeKind::List | ModeKind::Prefix(_) => true,
                ModeKind::AlwaysArg => change.mode != 'k' || set,
                ModeKind::ArgWhenSet => set,
                ModeKind::NoArg => false,
            };
            if needs_argument && change.arg.is_none() {
                return Err(EngineMessageKey::ComposerMissingArgument);
            }
            Ok(TypedModeChange {
                set,
                mode: change.mode,
                member_mode: matches!(change.kind, ModeKind::Prefix(_)),
                argument: change.arg.map(str::to_owned),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let consumed = changes
        .iter()
        .filter(|change| change.argument.is_some())
        .count();
    if changes.is_empty() {
        return Err(EngineMessageKey::ComposerMissingArgument);
    }
    if consumed < arguments.len() {
        return Err(EngineMessageKey::ComposerUnexpectedArgument);
    }
    Ok(changes)
}

// TODO(papo-0.1): papo parses mode strings against its own ISUPPORT but does not expose that
// parser, so the engine rebuilds the two tokens it needs.
pub(crate) fn mode_semantics(isupport: &papo::Isupport) -> Isupport {
    let mut semantics = Isupport::default();
    semantics.apply_tokens(["CHANMODES", "PREFIX"].into_iter().filter_map(|key| {
        match isupport.get(key) {
            Advertised::Value(value) => Some(format!("{key}={value}")),
            Advertised::Absent | Advertised::Bare => None,
        }
    }));
    semantics
}

/// Channel modes as `/mode` shows them: sorted letters, then the visible arguments; a key
/// stays hidden.
pub(crate) fn describe_channel_modes(channel: &papo::Channel) -> String {
    let mut modes = channel.modes().collect::<Vec<_>>();
    modes.sort_by_key(|(mode, _)| *mode);
    let letters = modes.iter().map(|(mode, _)| *mode).collect::<String>();
    let arguments = modes
        .iter()
        .filter(|(mode, _)| *mode != 'k')
        .filter_map(|(_, value)| value.value());
    std::iter::once(format!("+{letters}"))
        .chain(arguments.map(str::to_owned))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::{TypedModeChange, parse_mode_string};
    use crate::EngineMessageKey;

    fn change(set: bool, mode: char, argument: Option<&str>) -> TypedModeChange {
        TypedModeChange {
            set,
            mode,
            member_mode: matches!(mode, 'o' | 'v'),
            argument: argument.map(str::to_owned),
        }
    }

    fn ergo_semantics() -> papo_proto::Isupport {
        let mut semantics = papo_proto::Isupport::default();
        semantics.apply_tokens(["CHANMODES=beI,k,l,imnst", "PREFIX=(ov)@+"]);
        semantics
    }

    #[test]
    fn typed_modes_take_their_arguments_in_order() {
        let isupport = ergo_semantics();
        assert_eq!(
            parse_mode_string(&isupport, "+mo-v+l mel iris 50"),
            Ok(vec![
                change(true, 'm', None),
                change(true, 'o', Some("mel")),
                change(false, 'v', Some("iris")),
                change(true, 'l', Some("50")),
            ])
        );
        assert_eq!(
            parse_mode_string(&isupport, "-lk"),
            Ok(vec![change(false, 'l', None), change(false, 'k', None)])
        );
        assert_eq!(
            parse_mode_string(&isupport, "+k-k sekrit old"),
            Ok(vec![
                change(true, 'k', Some("sekrit")),
                change(false, 'k', Some("old"))
            ])
        );
        assert_eq!(
            parse_mode_string(&isupport, "+ov-l mel iris"),
            Ok(vec![
                change(true, 'o', Some("mel")),
                change(true, 'v', Some("iris")),
                change(false, 'l', None),
            ])
        );
        assert_eq!(
            parse_mode_string(&isupport, "+b *!*@spam.example"),
            Ok(vec![change(true, 'b', Some("*!*@spam.example"))])
        );
    }

    #[test]
    fn unknown_letters_missing_and_extra_arguments_are_refused() {
        let isupport = ergo_semantics();
        for (input, refusal) in [
            ("+Z", EngineMessageKey::ModeUnknown),
            ("+o", EngineMessageKey::ComposerMissingArgument),
            ("+k", EngineMessageKey::ComposerMissingArgument),
            ("+m extra", EngineMessageKey::ComposerUnexpectedArgument),
            ("+", EngineMessageKey::ComposerMissingArgument),
            ("+b", EngineMessageKey::ComposerMissingArgument),
        ] {
            assert_eq!(parse_mode_string(&isupport, input), Err(refusal), "{input}");
        }
    }
}
