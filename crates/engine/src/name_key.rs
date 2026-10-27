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
    pub(crate) fn from_conversation(conversation: &papo::Conversation) -> Self {
        match conversation {
            papo::Conversation::Channel(channel) => Self::Channel(channel.clone()),
            papo::Conversation::Private(nick) => Self::Direct(nick.clone()),
            _ => unreachable!("papo conversation gained an unsupported variant"),
        }
    }

    pub(crate) fn title(&self) -> String {
        match self {
            Self::Channel(channel) => channel.to_string(),
            Self::Direct(nick) => nick.to_string(),
        }
    }
}
