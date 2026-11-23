//! Typed IRC lookup keys built from papo's server-provided name rules.

/// A channel or direct-message identity under papo's active casemapping.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum NameKey {
    /// Typed channel identity.
    Channel(papo::ChannelName),
    /// Typed nickname identity.
    Direct(papo::Nick),
}

impl NameKey {
    pub(crate) fn from_conversation(conversation: &papo::Conversation) -> Option<Self> {
        match conversation {
            papo::Conversation::Channel(channel) => Some(Self::Channel(channel.name())),
            papo::Conversation::Private(user) => Some(Self::Direct(user.nick())),
            _ => None,
        }
    }

    pub(crate) fn title(&self) -> String {
        match self {
            Self::Channel(channel) => channel.to_string(),
            Self::Direct(nick) => nick.to_string(),
        }
    }
}

/// The user papo tracks under `nick`. The engine only looks up names its own client built, so a
/// foreign-reference refusal cannot happen and would mean the user is unknown here anyway.
pub(crate) fn known_user(state: &papo::State, nick: impl papo::AsNick) -> Option<&papo::User> {
    state.user(nick).ok().flatten()
}

/// The channel papo tracks under `channel`, by the same reasoning as [`known_user`].
pub(crate) fn known_channel(
    state: &papo::State,
    channel: impl papo::AsChannel,
) -> Option<&papo::Channel> {
    state.channel(channel).ok().flatten()
}

/// The comparison rules papo builds names with; servers that never said fall back to papo's seed.
pub(crate) fn casemapping(state: &papo::State) -> papo::Casemapping {
    state
        .name_rules()
        .map_or_else(papo::Casemapping::default, |rules| {
            rules.nick(String::new()).casemapping()
        })
}

#[cfg(test)]
mod tests {
    use super::NameKey;

    #[test]
    fn conversation_conversion_is_fallible_for_future_variants() {
        let (client, _events, _driver) = papo::Client::builder("irc://offline.test", "weblounge")
            .casemapping(papo::Casemapping::Rfc1459)
            .build();
        let conversation =
            papo_testing::channel_conversation(&client, "#room").expect("seeded rules");

        let key: Option<NameKey> = NameKey::from_conversation(&conversation);

        assert!(matches!(key, Some(NameKey::Channel(channel)) if channel == "#room"));
    }
}
