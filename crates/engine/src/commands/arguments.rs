use super::{CommandArgumentKind, CommandArgumentSpec, InputError};

pub(crate) struct ParseContext<'a> {
    pub(crate) chantypes: &'a str,
}

impl ParseContext<'_> {
    /// A word an optional `Channel` argument consumes: `*` (the current buffer) or a channel name.
    pub(crate) fn names_channel(&self, word: &str) -> bool {
        word == "*" || word.starts_with(|first| self.chantypes.contains(first))
    }
}

/// The index of the argument that the last word of `typed` fills, walking `arguments` the way
/// the parser consumes them; `arguments.len()` once every argument is filled.
pub(crate) fn active_argument(
    arguments: &[CommandArgumentSpec],
    typed: &str,
    context: &ParseContext<'_>,
) -> usize {
    let mut tokens = Tokens::new(typed);
    for (index, argument) in arguments.iter().enumerate() {
        let Some(word) = tokens.peek() else {
            return index;
        };
        if argument.rest {
            return index;
        }
        if argument.kind == CommandArgumentKind::Channel && !context.names_channel(word) {
            continue;
        }
        if tokens.remaining == word {
            return index;
        }
        tokens.word();
    }
    arguments.len()
}

pub(crate) struct Tokens<'a> {
    remaining: &'a str,
}

impl<'a> Tokens<'a> {
    pub(crate) fn new(input: &'a str) -> Self {
        Self {
            remaining: input.trim_start(),
        }
    }

    pub(crate) fn word(&mut self) -> Option<&'a str> {
        let input = self.remaining;
        if input.is_empty() {
            return None;
        }
        let (word, remaining) = input
            .split_once(char::is_whitespace)
            .map_or((input, ""), |(word, rest)| (word, rest.trim_start()));
        self.remaining = remaining;
        Some(word)
    }

    pub(crate) fn text(&mut self) -> Option<&'a str> {
        let text = (!self.remaining.is_empty()).then_some(self.remaining);
        self.remaining = "";
        text
    }

    pub(crate) fn peek(&self) -> Option<&'a str> {
        self.remaining.split_whitespace().next()
    }

    pub(crate) fn finish(&self) -> Result<(), InputError> {
        self.remaining
            .is_empty()
            .then_some(())
            .ok_or(InputError::UnexpectedArgument)
    }
}

pub(crate) trait CommandArg: Sized {
    const KIND: CommandArgumentKind;
    const CONSUMES_REST: bool = false;
    fn parse(tokens: &mut Tokens<'_>, context: &ParseContext<'_>) -> Result<Self, InputError>;
    fn spec(name: &str) -> CommandArgumentSpec {
        CommandArgumentSpec {
            name: name.into(),
            kind: Self::KIND,
            required: true,
            rest: Self::CONSUMES_REST,
        }
    }
}

impl<T: CommandArg> CommandArg for Option<T> {
    const KIND: CommandArgumentKind = T::KIND;
    const CONSUMES_REST: bool = T::CONSUMES_REST;
    fn parse(tokens: &mut Tokens<'_>, context: &ParseContext<'_>) -> Result<Self, InputError> {
        if tokens.remaining.is_empty() {
            Ok(None)
        } else {
            T::parse(tokens, context).map(Some)
        }
    }
    fn spec(name: &str) -> CommandArgumentSpec {
        CommandArgumentSpec {
            required: false,
            ..T::spec(name)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Tokens;

    #[test]
    fn separates_words_from_rest_of_line_text() {
        let mut tokens = Tokens::new("  first  rest of line");
        assert_eq!(tokens.word(), Some("first"));
        assert_eq!(tokens.text(), Some("rest of line"));
        assert!(tokens.finish().is_ok());
    }
}
