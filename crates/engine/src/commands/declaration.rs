use super::{
    CommandPermission, CommandRequirement, CommandSpec, CommandSurface, ConfirmPolicy, InputError,
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
        description = "cmd.msg.description", surfaces = ["Slash", "Palette"]
    )]
    Msg { target: Target, text: Text },
    #[command(
        name = "query", aliases = ["q"], usage = "cmd.query.usage",
        description = "cmd.query.description", surfaces = ["Slash", "Palette", "UserMenu"]
    )]
    Query { nick: Nick, text: Option<Text> },
    #[command(
        name = "notice", aliases = [], usage = "cmd.notice.usage",
        description = "cmd.notice.description", surfaces = ["Slash"]
    )]
    Notice { target: Target, text: Text },
    #[command(
        name = "me", aliases = [], usage = "cmd.me.usage", description = "cmd.me.description",
        surfaces = ["Slash"]
    )]
    Me { text: Text },
    #[command(
        name = "join", aliases = ["j"], usage = "cmd.join.usage",
        description = "cmd.join.description", surfaces = ["Slash", "Palette", "NetworkMenu"]
    )]
    Join {
        channels: ChannelList,
        keys: Option<KeyList>,
    },
    #[command(
        name = "part", aliases = ["leave"], usage = "cmd.part.usage",
        description = "cmd.part.description", surfaces = ["Slash", "Palette", "ChannelMenu"],
        confirm = "Menu"
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
        description = "cmd.topic.description", surfaces = ["Slash", "Palette", "ChannelMenu"]
    )]
    Topic {
        channel: Channel,
        text: Option<Text>,
    },
    #[command(
        name = "nick", aliases = [], usage = "cmd.nick.usage", description = "cmd.nick.description",
        surfaces = ["Slash", "Palette", "NetworkMenu"]
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
}

#[cfg(test)]
mod tests {
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
        assert_eq!(specs.len(), 13);
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
        ] {
            assert!(commands::parse(input, "#&").is_ok(), "input: {input}");
        }
        assert!(matches!(
            commands::parse("/whois mel", "#&"),
            Err(commands::InputError::UnknownCommand(name)) if name == "whois"
        ));
    }
}
