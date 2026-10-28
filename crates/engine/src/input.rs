#![allow(
    missing_docs,
    reason = "the closed AST names mirror the documented grammar"
)]

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ParsedInput {
    Message(String),
    Me(String),
    Join { targets: Vec<JoinTarget> },
    Part { reason: Option<String> },
    Msg { nick: String, text: String },
    Nick { nick: String },
    Topic { text: String },
    Quit { reason: Option<String> },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JoinTarget {
    pub channel: String,
    pub key: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InputError {
    Empty,
    MissingArgument,
    UnknownCommand,
}

impl InputError {
    #[must_use]
    pub const fn message_key(self) -> &'static str {
        match self {
            Self::Empty => "composer.empty_input",
            Self::MissingArgument => "composer.missing_argument",
            Self::UnknownCommand => "composer.unknown_command",
        }
    }
}

/// # Errors
/// Returns a typed error for empty, incomplete, or unknown input.
pub fn parse(input: &str) -> Result<ParsedInput, InputError> {
    if input.is_empty() {
        return Err(InputError::Empty);
    }
    let Some(command_line) = input.strip_prefix('/') else {
        return Ok(ParsedInput::Message(input.to_owned()));
    };
    let (command, arguments) = split_once(command_line);
    match command.to_ascii_lowercase().as_str() {
        "me" => Ok(ParsedInput::Me(required(arguments)?)),
        "join" => Ok(ParsedInput::Join {
            targets: join_targets(arguments)?,
        }),
        "part" => Ok(ParsedInput::Part {
            reason: optional(arguments),
        }),
        "msg" => {
            let (nick, text) = split_once(arguments);
            Ok(ParsedInput::Msg {
                nick: required(nick)?,
                text: required(text)?,
            })
        }
        "nick" => Ok(ParsedInput::Nick {
            nick: required(arguments)?,
        }),
        "topic" => Ok(ParsedInput::Topic {
            text: required(arguments)?,
        }),
        "quit" => Ok(ParsedInput::Quit {
            reason: optional(arguments),
        }),
        _ => Err(InputError::UnknownCommand),
    }
}

fn split_once(input: &str) -> (&str, &str) {
    let input = input.trim_start();
    input
        .split_once(char::is_whitespace)
        .map_or((input, ""), |(head, tail)| (head, tail.trim_start()))
}

fn required(input: &str) -> Result<String, InputError> {
    (!input.is_empty())
        .then(|| input.to_owned())
        .ok_or(InputError::MissingArgument)
}

fn optional(input: &str) -> Option<String> {
    (!input.is_empty()).then(|| input.to_owned())
}

fn join_targets(arguments: &str) -> Result<Vec<JoinTarget>, InputError> {
    let (channels, keys) = split_once(arguments);
    if channels.is_empty() {
        return Err(InputError::MissingArgument);
    }
    let keys = keys.split(',').map(str::to_owned).collect::<Vec<_>>();
    channels
        .split(',')
        .enumerate()
        .map(|(index, channel)| {
            (!channel.is_empty())
                .then(|| JoinTarget {
                    channel: channel.to_owned(),
                    key: keys.get(index).filter(|key| !key.is_empty()).cloned(),
                })
                .ok_or(InputError::MissingArgument)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{InputError, ParsedInput, parse};

    #[test]
    fn parses_messages_and_supported_commands() {
        let cases = [
            ("hello\nworld", ParsedInput::Message("hello\nworld".into())),
            ("/ME waves", ParsedInput::Me("waves".into())),
            (
                "/join   #rust key",
                ParsedInput::Join {
                    targets: vec![super::JoinTarget {
                        channel: "#rust".into(),
                        key: Some("key".into()),
                    }],
                },
            ),
            (
                "/join #a,#b key1,key2",
                ParsedInput::Join {
                    targets: vec![
                        super::JoinTarget {
                            channel: "#a".into(),
                            key: Some("key1".into()),
                        },
                        super::JoinTarget {
                            channel: "#b".into(),
                            key: Some("key2".into()),
                        },
                    ],
                },
            ),
            (
                "/part later",
                ParsedInput::Part {
                    reason: Some("later".into()),
                },
            ),
            ("/part", ParsedInput::Part { reason: None }),
            (
                "/msg mel hello there",
                ParsedInput::Msg {
                    nick: "mel".into(),
                    text: "hello there".into(),
                },
            ),
            (
                "/nick new-name",
                ParsedInput::Nick {
                    nick: "new-name".into(),
                },
            ),
            (
                "/topic release room",
                ParsedInput::Topic {
                    text: "release room".into(),
                },
            ),
            ("/quit", ParsedInput::Quit { reason: None }),
        ];
        for (input, expected) in cases {
            assert_eq!(parse(input), Ok(expected), "input: {input}");
        }
    }

    #[test]
    fn rejects_invalid_commands_without_raw_fallback() {
        assert_eq!(parse(""), Err(InputError::Empty));
        assert_eq!(parse("/me"), Err(InputError::MissingArgument));
        assert_eq!(parse("/msg mel"), Err(InputError::MissingArgument));
        assert_eq!(parse("/whois mel"), Err(InputError::UnknownCommand));
    }
}
