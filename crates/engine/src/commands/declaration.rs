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
        name = "identify", aliases = ["id"], usage = "cmd.identify.usage",
        description = "cmd.identify.description", surfaces = ["Slash"], secret
    )]
    Identify { password: Text },
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

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
        assert_eq!(specs.len(), 14);
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
            for spec in Command::specs() {
                if allowed_incidental(relative, &spec.name) {
                    continue;
                }
                let quoted = format!("\"{}\"", spec.name);
                let single_quoted = format!("'{}'", spec.name);
                if production.contains(&quoted) || production.contains(&single_quoted) {
                    stray.push(format!("{}: {}", relative.display(), spec.name));
                }
            }
        }
        assert!(
            stray.is_empty(),
            "command-name literals outside declaration.rs: {stray:#?}"
        );
    }

    fn source_files(directory: &Path, files: &mut Vec<std::path::PathBuf>) {
        if !directory.exists() {
            return;
        }
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
            || path.ends_with("features/composer/strings.ts")
    }

    fn allowed_incidental(path: &Path, name: &str) -> bool {
        let path = path.to_string_lossy();
        matches!(
            (path.as_ref(), name),
            (
                "app/src/App.tsx"
                    | "app/src/engine/createEngineClient.ts"
                    | "app/src/engine/worker-runtime.ts"
                    | "app/src/features/conversation/message-size-estimate.ts",
                "notice",
            ) | ("app/src/actions/action-registry.ts", "help")
                | ("app/src/engine/EngineClient.ts", "notice" | "part" | "quit")
                | (
                    "app/src/features/conversation/MessageList.tsx",
                    "notice" | "quit",
                )
                | (
                    "app/src/features/conversation/MessageText.tsx"
                        | "app/src/features/conversation/message-tokenizer.ts",
                    "nick",
                )
        )
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
