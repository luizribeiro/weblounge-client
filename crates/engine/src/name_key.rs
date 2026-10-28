//! Typed IRC lookup keys isolated for papo's planned 0.1 name API changes.

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
            papo::Conversation::Channel(channel) => Some(Self::Channel(channel.clone())),
            papo::Conversation::Private(nick) => Some(Self::Direct(nick.clone())),
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

pub(crate) trait RequiredNameRules {
    fn required_name_rules(&self) -> papo::NameRules<'_>;
}

impl RequiredNameRules for papo::State {
    fn required_name_rules(&self) -> papo::NameRules<'_> {
        self.name_rules()
            .expect("name construction is gated until server rules arrive")
    }
}

pub(crate) fn channel(state: &papo::State, text: impl Into<String>) -> papo::ChannelName {
    let text = text.into();
    if let Some(rules) = state.name_rules() {
        return rules.channel(text);
    }
    #[cfg(test)]
    return papo_testing::channel(state.casemapping(), text);
    #[cfg(not(test))]
    unreachable!("name construction is gated until server rules arrive")
}

pub(crate) fn nick(state: &papo::State, text: impl Into<String>) -> papo::Nick {
    let text = text.into();
    if let Some(rules) = state.name_rules() {
        return rules.nick(text);
    }
    #[cfg(test)]
    return papo_testing::nick(state.casemapping(), text);
    #[cfg(not(test))]
    unreachable!("name construction is gated until server rules arrive")
}

#[cfg(test)]
mod tests {
    use papo_testing::StateBuilder;

    use super::NameKey;

    #[test]
    fn conversation_conversion_is_fallible_for_future_variants() {
        let state = StateBuilder::new("weblounge").build();
        let conversation = papo::Conversation::Channel(super::channel(&state, "#room"));

        let key: Option<NameKey> = NameKey::from_conversation(&conversation);

        assert!(matches!(key, Some(NameKey::Channel(channel)) if channel == "#room"));
    }
}
