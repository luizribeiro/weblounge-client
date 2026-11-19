use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{
    CommandArgumentSpec, CommandRegistry, CommandSpec,
    arguments::{ParseContext, active_argument},
};

/// The parameters of the command being typed, for the composer's usage line.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct CommandUsage {
    /// Canonical command name, even when an alias was typed.
    pub name: String,
    /// The command's parameters in order.
    pub arguments: Vec<CommandArgumentSpec>,
    /// The parameter the caret is in; the last one once the input runs past it.
    pub active_argument: u32,
}

/// The registered slash command before the caret and the argument the caret is filling.
pub(crate) struct CommandPosition<'registry> {
    pub(crate) spec: &'registry CommandSpec,
    /// `spec.arguments.len()` once the input runs past the last argument.
    pub(crate) argument: usize,
}

impl<'registry> CommandPosition<'registry> {
    /// Only a typed `/`, a known name or alias and whitespace after it start the arguments.
    pub(crate) fn locate(
        before_caret: &str,
        chantypes: &str,
        registry: &'registry CommandRegistry,
    ) -> Option<Self> {
        let command = before_caret.strip_prefix('/')?;
        if command.starts_with('/') || !command.contains(char::is_whitespace) {
            return None;
        }
        let registered = registry.parse(command).ok()?;
        Some(Self {
            spec: registered.spec,
            argument: active_argument(
                &registered.spec.arguments,
                registered.arguments,
                &ParseContext { chantypes },
            ),
        })
    }

    pub(crate) fn current_argument(&self) -> Option<&'registry CommandArgumentSpec> {
        self.spec.arguments.get(self.argument)
    }

    /// A command without parameters has nothing to document.
    pub(crate) fn usage(&self) -> Option<CommandUsage> {
        let last = self.spec.arguments.len().checked_sub(1)?;
        Some(CommandUsage {
            name: self.spec.name.clone(),
            arguments: self.spec.arguments.clone(),
            active_argument: u32::try_from(self.argument.min(last)).ok()?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::CommandPosition;
    use crate::commands::built_in_registry;

    fn locate(input: &str) -> Option<(String, usize)> {
        let registry = built_in_registry();
        CommandPosition::locate(input, "#&", &registry)
            .map(|position| (position.spec.name.clone(), position.argument))
    }

    fn at(name: &str, argument: usize) -> (String, usize) {
        (name.to_owned(), argument)
    }

    #[test]
    fn join_moves_from_channels_to_keys() {
        assert_eq!(locate("/join "), Some(at("join", 0)));
        assert_eq!(locate("/join #dev"), Some(at("join", 0)));
        assert_eq!(locate("/join #dev,#ops"), Some(at("join", 0)));
        assert_eq!(locate("/join #dev "), Some(at("join", 1)));
        assert_eq!(locate("/join #dev sekrit"), Some(at("join", 1)));
        assert_eq!(locate("/j  #dev   sekrit"), Some(at("join", 1)));
    }

    #[test]
    fn a_word_past_the_last_argument_reports_the_end() {
        assert_eq!(locate("/join #dev sekrit "), Some(at("join", 2)));
        assert_eq!(locate("/nick newname extra"), Some(at("nick", 1)));
    }

    #[test]
    fn rest_of_line_text_keeps_every_later_word() {
        assert_eq!(locate("/kick mel"), Some(at("kick", 0)));
        assert_eq!(locate("/kick mel "), Some(at("kick", 1)));
        assert_eq!(locate("/kick mel link spam again"), Some(at("kick", 1)));
        assert_eq!(locate("/msg mel hello there "), Some(at("msg", 1)));
        assert_eq!(locate("/me waves at @al"), Some(at("me", 0)));
    }

    #[test]
    fn an_optional_channel_takes_only_a_channel_word() {
        assert_eq!(locate("/part "), Some(at("part", 0)));
        assert_eq!(locate("/part #"), Some(at("part", 0)));
        assert_eq!(locate("/part #dev "), Some(at("part", 1)));
        assert_eq!(locate("/part * bye"), Some(at("part", 1)));
        assert_eq!(locate("/part see"), Some(at("part", 1)));
        assert_eq!(locate("/topic new topic here"), Some(at("topic", 1)));
        assert_eq!(locate("/cycle &local"), Some(at("cycle", 0)));
    }

    #[test]
    fn needs_a_typed_known_command_and_whitespace() {
        assert_eq!(locate("/kick"), None);
        assert_eq!(locate("kick mel"), None);
        assert_eq!(locate("//kick mel"), None);
        assert_eq!(locate("/whois mel"), None);
        assert_eq!(locate("/ "), None);
        assert_eq!(locate("/close "), Some(at("close", 0)));
    }

    fn usage(input: &str) -> Option<super::CommandUsage> {
        let registry = built_in_registry();
        CommandPosition::locate(input, "#&", &registry)?.usage()
    }

    #[test]
    fn usage_names_the_canonical_command_and_keeps_the_last_parameter_active() {
        let join = usage("/j #dev sekrit extra").expect("join usage");
        assert_eq!(join.name, "join");
        assert_eq!(
            join.arguments
                .iter()
                .map(|argument| (argument.name.as_str(), argument.required, argument.rest))
                .collect::<Vec<_>>(),
            [("channels", true, false), ("keys", false, false)]
        );
        assert_eq!(join.active_argument, 1);
        assert_eq!(
            usage("/kick mel ").map(|kick| kick.active_argument),
            Some(1)
        );
        assert_eq!(usage("/close "), None);
        assert_eq!(usage("/whois mel"), None);
    }
}
