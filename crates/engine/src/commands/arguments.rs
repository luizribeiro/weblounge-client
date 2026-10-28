use super::{CommandArgumentKind, CommandArgumentSpec, InputError};

pub(crate) struct ParseContext<'a> {
    pub(crate) chantypes: &'a str,
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
    fn parse(tokens: &mut Tokens<'_>, context: &ParseContext<'_>) -> Result<Self, InputError>;
    fn spec(name: &str) -> CommandArgumentSpec {
        CommandArgumentSpec {
            name: name.into(),
            kind: Self::KIND,
            required: true,
        }
    }
}

impl<T: CommandArg> CommandArg for Option<T> {
    const KIND: CommandArgumentKind = T::KIND;
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
