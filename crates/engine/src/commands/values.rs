use super::{CommandArgumentKind, CommandArgumentSpec, InputError};
use crate::commands::arguments::{CommandArg, ParseContext, Tokens};

macro_rules! word_argument {
    ($name:ident, $kind:ident) => {
        #[derive(Clone, Debug, Eq, PartialEq)]
        pub(crate) struct $name(pub(crate) String);
        impl CommandArg for $name {
            const KIND: CommandArgumentKind = CommandArgumentKind::$kind;
            fn parse(tokens: &mut Tokens<'_>, _: &ParseContext<'_>) -> Result<Self, InputError> {
                tokens
                    .word()
                    .map(|value| Self(value.into()))
                    .ok_or(InputError::MissingArgument)
            }
        }
    };
}

word_argument!(Nick, Nick);
word_argument!(Target, Target);
word_argument!(CommandName, CommandName);

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Text(pub(crate) String);

impl CommandArg for Text {
    const KIND: CommandArgumentKind = CommandArgumentKind::Text;
    const CONSUMES_REST: bool = true;
    fn parse(tokens: &mut Tokens<'_>, _: &ParseContext<'_>) -> Result<Self, InputError> {
        tokens
            .text()
            .map(|value| Self(value.into()))
            .ok_or(InputError::MissingArgument)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Channel(pub(crate) Option<String>);

impl CommandArg for Channel {
    const KIND: CommandArgumentKind = CommandArgumentKind::Channel;
    fn parse(tokens: &mut Tokens<'_>, context: &ParseContext<'_>) -> Result<Self, InputError> {
        let explicit = tokens.peek().filter(|value| {
            *value == "*" || value.starts_with(|first| context.chantypes.contains(first))
        });
        Ok(Self(explicit.and_then(|_| tokens.word()).and_then(
            |value| (value != "*").then(|| value.to_owned()),
        )))
    }
    fn spec(name: &str) -> CommandArgumentSpec {
        CommandArgumentSpec {
            required: false,
            ..CommandArgumentSpec {
                name: name.into(),
                kind: Self::KIND,
                required: true,
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ChannelList(pub(crate) Vec<String>);

impl CommandArg for ChannelList {
    const KIND: CommandArgumentKind = CommandArgumentKind::ChannelList;
    fn parse(tokens: &mut Tokens<'_>, context: &ParseContext<'_>) -> Result<Self, InputError> {
        let prefix = context.chantypes.chars().next().unwrap_or('#');
        comma_list(tokens).map(|values| {
            Self(
                values
                    .into_iter()
                    .map(|value| {
                        if value.starts_with(|first| context.chantypes.contains(first)) {
                            value
                        } else {
                            format!("{prefix}{value}")
                        }
                    })
                    .collect(),
            )
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct KeyList(pub(crate) Vec<String>);

impl CommandArg for KeyList {
    const KIND: CommandArgumentKind = CommandArgumentKind::KeyList;
    fn parse(tokens: &mut Tokens<'_>, _: &ParseContext<'_>) -> Result<Self, InputError> {
        comma_list(tokens).map(Self)
    }
}

fn comma_list(tokens: &mut Tokens<'_>) -> Result<Vec<String>, InputError> {
    let values = tokens
        .word()
        .ok_or(InputError::MissingArgument)?
        .split(',')
        .map(str::to_owned)
        .collect::<Vec<_>>();
    (!values.iter().any(String::is_empty))
        .then_some(values)
        .ok_or(InputError::MissingArgument)
}

#[cfg(test)]
mod tests {
    use super::{Channel, ChannelList, CommandArg, ParseContext, Text, Tokens};

    #[test]
    fn defaults_channel_without_consuming_text() {
        let context = ParseContext { chantypes: "#&" };
        let mut tokens = Tokens::new("reason here");
        assert_eq!(Channel::parse(&mut tokens, &context), Ok(Channel(None)));
        assert_eq!(
            Text::parse(&mut tokens, &context),
            Ok(Text("reason here".into()))
        );
    }

    #[test]
    fn parses_channel_lists_and_adds_the_default_prefix() {
        let context = ParseContext { chantypes: "#&" };
        let mut tokens = Tokens::new("one,&two");
        assert_eq!(
            ChannelList::parse(&mut tokens, &context),
            Ok(ChannelList(vec!["#one".into(), "&two".into()]))
        );
    }

    #[test]
    fn text_declares_that_it_consumes_the_rest_of_input() {
        const _: () = assert!(Text::CONSUMES_REST);
        const _: () = assert!(<Option<Text>>::CONSUMES_REST);
        const _: () = assert!(!Channel::CONSUMES_REST);
    }
}
