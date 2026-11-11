use super::{
    CommandPermission, CommandRequirement, CommandSpec, CommandSurface, CompletionPriority,
    ConfirmPolicy, InputError,
    arguments::{CommandArg, ParseContext, Tokens},
    values::{Channel, ChannelList, CommandName, KeyList, Nick, Target, Text},
};

#[derive(Clone, Debug, Eq, PartialEq, weblounge_command_derive::Command)]
pub(crate) enum Command {
    #[command(
        name = "say", aliases = [], usage = "cmd.say.usage", description = "cmd.say.description",
        surfaces = ["Slash"]
    )]
    Say { text: Text },
    #[command(
        name = "msg", aliases = ["m", "privmsg"], usage = "cmd.msg.usage",
        description = "cmd.msg.description", surfaces = ["Slash", "Palette"],
        completion = "Everyday"
    )]
    Msg { target: Target, text: Text },
    #[command(
        name = "query", aliases = ["q"], usage = "cmd.query.usage",
        description = "cmd.query.description", surfaces = ["Slash", "Palette", "UserMenu"],
        completion = "Everyday"
    )]
    Query { nick: Nick, text: Option<Text> },
    #[command(
        name = "notice", aliases = [], usage = "cmd.notice.usage",
        description = "cmd.notice.description", surfaces = ["Slash"]
    )]
    Notice { target: Target, text: Text },
    #[command(
        name = "me", aliases = [], usage = "cmd.me.usage", description = "cmd.me.description",
        surfaces = ["Slash"], completion = "Everyday"
    )]
    Me { text: Text },
    #[command(
        name = "join", aliases = ["j"], usage = "cmd.join.usage",
        description = "cmd.join.description", surfaces = ["Slash", "Palette", "NetworkMenu"],
        completion = "Everyday"
    )]
    Join {
        channels: ChannelList,
        keys: Option<KeyList>,
    },
    #[command(
        name = "part", aliases = ["leave"], usage = "cmd.part.usage",
        description = "cmd.part.description", surfaces = ["Slash", "Palette", "ChannelMenu"],
        confirm = "Menu", completion = "Everyday"
    )]
    Part {
        channel: Channel,
        reason: Option<Text>,
    },
    #[command(
        name = "close", aliases = ["wc"], usage = "cmd.close.usage",
        description = "cmd.close.description", surfaces = ["Slash", "Palette", "ChannelMenu"],
        confirm = "Menu"
    )]
    Close {},
    #[command(
        name = "cycle", aliases = ["rejoin", "hop"], usage = "cmd.cycle.usage",
        description = "cmd.cycle.description", surfaces = ["Slash", "ChannelMenu"]
    )]
    Cycle {
        channel: Channel,
        reason: Option<Text>,
    },
    #[command(
        name = "topic", aliases = ["t"], usage = "cmd.topic.usage",
        description = "cmd.topic.description", surfaces = ["Slash", "Palette", "ChannelMenu"],
        completion = "Everyday"
    )]
    Topic {
        channel: Channel,
        text: Option<Text>,
    },
    #[command(
        name = "nick", aliases = [], usage = "cmd.nick.usage", description = "cmd.nick.description",
        surfaces = ["Slash", "Palette", "NetworkMenu"], completion = "Everyday"
    )]
    Nick { nick: Nick },
    #[command(
        name = "quit", aliases = ["exit", "bye", "signoff"], usage = "cmd.quit.usage",
        description = "cmd.quit.description", surfaces = ["Slash", "Palette"], confirm = "Always"
    )]
    Quit { reason: Option<Text> },
    #[command(
        name = "help", aliases = ["?", "commands"], usage = "cmd.help.usage",
        description = "cmd.help.description", surfaces = ["Slash", "Palette"]
    )]
    Help { command: Option<CommandName> },
    #[command(
        name = "version", aliases = [], usage = "cmd.version.usage",
        description = "cmd.version.description", surfaces = ["Slash", "Palette"]
    )]
    Version {},
    #[command(
        name = "identify", aliases = ["id"], usage = "cmd.identify.usage",
        description = "cmd.identify.description", surfaces = ["Slash"], secret
    )]
    Identify { password: Text },
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{BTreeSet, HashSet},
        fs,
        path::Path,
    };

    use super::Command;
    use crate::commands::{self, CommandArgumentKind};

    #[test]
    fn derive_generates_alias_parser_and_typed_specs() {
        assert!(matches!(
            commands::parse("/J room other", "#&"),
            Ok(Command::Join { channels, keys: Some(keys) })
                if channels.0 == ["#room"] && keys.0 == ["other"]
        ));
        let specs = Command::specs();
        let join = specs
            .iter()
            .find(|spec| spec.name == "join")
            .expect("join exists");
        assert_eq!(join.aliases, ["j"]);
        assert_eq!(join.arguments[0].kind, CommandArgumentKind::ChannelList);
        assert_eq!(specs.len(), 15);
        assert!(
            specs
                .iter()
                .find(|spec| spec.name == "identify")
                .is_some_and(|spec| spec.secret_arguments)
        );
    }

    #[test]
    fn derive_parses_a_registry_resolved_command() {
        assert!(matches!(
            Command::parse_registered(
                "join",
                "room other",
                &commands::arguments::ParseContext { chantypes: "#&" }
            ),
            Ok(Command::Join { channels, keys: Some(keys) })
                if channels.0 == ["#room"] && keys.0 == ["other"]
        ));
    }

    #[test]
    fn command_names_have_no_second_source_list() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let specs = Command::specs();
        let command_names = specs.iter().map(|spec| spec.name.clone()).collect();
        let mut files = Vec::new();
        source_files(&root.join("crates"), &mut files);
        source_files(&root.join("app/src"), &mut files);
        let mut stray = Vec::new();
        for path in files {
            let relative = path.strip_prefix(&root).expect("source is in repository");
            if ignored_source(relative) {
                continue;
            }
            let source = fs::read_to_string(&path).expect("source is readable");
            let production = source.split("\n#[cfg(test)]").next().unwrap_or_default();
            for name in command_list_names(production, &command_names) {
                stray.push(format!("{}: {name}", relative.display()));
            }
        }
        assert!(
            stray.is_empty(),
            "command-name lists outside declaration.rs: {stray:#?}"
        );
    }

    #[test]
    fn command_list_detector_rejects_a_real_second_source() {
        let command_names =
            HashSet::from(["join".to_owned(), "part".to_owned(), "quit".to_owned()]);
        let duplicate = r#"const commands = new Set(["join", "part", "quit"]);"#;
        assert_eq!(
            command_list_names(duplicate, &command_names),
            BTreeSet::from(["join".to_owned(), "part".to_owned(), "quit".to_owned()])
        );

        let protocol_discriminants =
            r#"switch (event.type) { case "join": break; case "part": break; }"#;
        assert!(command_list_names(protocol_discriminants, &command_names).is_empty());
    }

    fn command_list_names(source: &str, command_names: &HashSet<String>) -> BTreeSet<String> {
        let bytes = source.as_bytes();
        let mut delimiters = Vec::<(u8, BTreeSet<String>)>::new();
        let mut duplicates = BTreeSet::new();
        let mut index = 0;

        while index < bytes.len() {
            if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'/') {
                index += 2;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
                continue;
            }
            if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'*') {
                index += 2;
                while index + 1 < bytes.len() && (bytes[index] != b'*' || bytes[index + 1] != b'/')
                {
                    index += 1;
                }
                index = (index + 2).min(bytes.len());
                continue;
            }
            if matches!(bytes[index], b'"' | b'\'' | b'`') {
                let quote = bytes[index];
                let start = index + 1;
                index = start;
                while index < bytes.len() && bytes[index] != quote {
                    if bytes[index] == b'\\' {
                        index = (index + 2).min(bytes.len());
                    } else if bytes[index] == b'\n' && quote == b'\'' {
                        break;
                    } else {
                        index += 1;
                    }
                }
                if index < bytes.len() && bytes[index] == quote {
                    if quote != b'`'
                        && let Some((b'[', names)) = delimiters.last_mut()
                    {
                        let literal = &source[start..index];
                        let name = literal.strip_prefix('/').unwrap_or(literal);
                        if command_names.contains(name) {
                            names.insert(name.to_owned());
                        }
                    }
                    index += 1;
                }
                continue;
            }
            if matches!(bytes[index], b'(' | b'[' | b'{') {
                delimiters.push((bytes[index], BTreeSet::new()));
            } else if matches!(bytes[index], b')' | b']' | b'}')
                && let Some((open, names)) = delimiters.pop()
                && open == b'['
                && bytes[index] == b']'
                && names.len() >= 2
            {
                duplicates.extend(names);
            }
            index += 1;
        }

        duplicates
    }

    fn source_files(directory: &Path, files: &mut Vec<std::path::PathBuf>) {
        assert!(
            directory.is_dir(),
            "source directory is missing: {}",
            directory.display()
        );
        for entry in fs::read_dir(directory).expect("source directory is readable") {
            let path = entry.expect("source entry is readable").path();
            if path.is_dir() {
                source_files(&path, files);
            } else if matches!(
                path.extension().and_then(std::ffi::OsStr::to_str),
                Some("rs" | "ts" | "tsx")
            ) {
                files.push(path);
            }
        }
    }

    fn ignored_source(path: &Path) -> bool {
        let path = path.to_string_lossy();
        path.ends_with("commands/declaration.rs")
            || path.contains("/tests/")
            || path.contains("/generated/")
            || path.contains(".test.")
            || path.ends_with("app/src/strings.ts")
    }

    #[test]
    fn plain_say_and_literal_slash_share_the_typed_ast() {
        assert!(
            matches!(commands::parse("hello", "#&"), Ok(Command::Say { text }) if text.0 == "hello")
        );
        assert!(
            matches!(commands::parse("//join #x", "#&"), Ok(Command::Say { text }) if text.0 == "/join #x")
        );
    }

    #[test]
    fn catalog_syntax_and_aliases_parse_without_a_raw_fallback() {
        for input in [
            "/say /literal",
            "/m nick hello",
            "/q nick hello",
            "/notice nick hello",
            "/me waves",
            "/j one,#two key1,key2",
            "/leave reason",
            "/close",
            "/hop",
            "/t new topic",
            "/nick new-name",
            "/exit later",
            "/help join",
            "/version",
            "/id hunter2",
        ] {
            assert!(commands::parse(input, "#&").is_ok(), "input: {input}");
        }
        assert!(matches!(
            commands::parse("/whois mel", "#&"),
            Err(commands::InputError::UnknownCommand(name)) if name == "whois"
        ));
    }
}
