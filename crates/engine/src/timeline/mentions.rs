//! Nicks mentioned inside message text.

use std::collections::HashSet;

use super::{FoldEvent, Person, RecordBody, TimelineRecord};

/// Every nick a buffer has known, folded with the network's casemapping.
///
/// The set only grows: a message keeps its coloured mentions after the person leaves.
pub(crate) struct MentionVocabulary {
    casemapping: papo::Casemapping,
    own: String,
    keys: HashSet<String>,
}

impl MentionVocabulary {
    pub(crate) fn new<'a>(
        casemapping: papo::Casemapping,
        own_nick: &str,
        remembered: impl IntoIterator<Item = &'a String>,
        records: &[TimelineRecord],
    ) -> Self {
        let own = casemapping.fold(own_nick).into_owned();
        let mut keys = remembered.into_iter().cloned().collect::<HashSet<_>>();
        keys.insert(own.clone());
        for record in records {
            record_nicks(&record.body, |nick| {
                keys.insert(casemapping.fold(nick).into_owned());
            });
        }
        Self {
            casemapping,
            own,
            keys,
        }
    }

    /// Each distinct known nick in `text`, spelled as written, in first-mention order.
    pub(crate) fn mentions(&self, text: &str) -> Vec<Person> {
        let mut seen = HashSet::new();
        nick_tokens(text)
            .filter(|token| seen.insert(*token))
            .filter_map(|token| {
                let key = self.casemapping.fold(token);
                self.keys.contains(key.as_ref()).then(|| Person {
                    nick: token.to_owned(),
                    nick_color_index: crate::state::nick_color_index(self.casemapping, token),
                    me: key == self.own,
                })
            })
            .collect()
    }
}

/// The nick-shaped words of `text`.
pub(crate) fn nick_tokens(text: &str) -> impl Iterator<Item = &str> {
    text.split(|character| !is_nick_character(character))
        .filter(|token| !token.is_empty())
}

fn is_nick_character(character: char) -> bool {
    character.is_alphanumeric()
        || matches!(
            character,
            '_' | '-' | '[' | ']' | '\\' | '`' | '^' | '{' | '}' | '|'
        )
}

fn record_nicks<'a>(body: &'a RecordBody, mut visit: impl FnMut(&'a str)) {
    match body {
        RecordBody::Chat(chat) => visit(&chat.projection.author),
        RecordBody::Fold(
            FoldEvent::Joined(who)
            | FoldEvent::Parted(who, _)
            | FoldEvent::Quit(who, ..)
            | FoldEvent::Invited { subject: who, .. },
        ) => visit(&who.nick),
        RecordBody::Fold(FoldEvent::Nick { old, new }) => {
            visit(&old.nick);
            visit(&new.nick);
        }
        RecordBody::Fold(FoldEvent::Modes { .. }) | RecordBody::Line(_) | RecordBody::Gap(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::MentionVocabulary;
    use crate::MessageId;
    use crate::timeline::{FoldEvent, LocalDay, OrderKey, RecordBody, TimelineRecord, Who};

    fn who(nick: &str) -> Who {
        Who {
            nick: nick.to_owned(),
            key: nick.to_lowercase(),
            nick_color_index: 0,
            own: false,
            msgid: None,
        }
    }

    fn record(id: u64, event: FoldEvent) -> TimelineRecord {
        TimelineRecord {
            id: MessageId(id),
            order: OrderKey::new(1_000, 1_010, id),
            day: LocalDay(1),
            body: RecordBody::Fold(event),
        }
    }

    #[test]
    fn learns_nicks_from_membership_events_in_the_timeline() {
        let records = [
            record(1, FoldEvent::Joined(who("mel"))),
            record(2, FoldEvent::Parted(who("tomo"), None)),
            record(3, FoldEvent::Quit(who("sheki"), None, None)),
            record(
                4,
                FoldEvent::Nick {
                    old: who("ana"),
                    new: who("ana_away"),
                },
            ),
        ];
        let vocabulary =
            MentionVocabulary::new(papo::Casemapping::Rfc1459, "weblounge", [], &records);

        let nicks = vocabulary
            .mentions("mel tomo sheki ana ana_away bob")
            .into_iter()
            .map(|person| person.nick)
            .collect::<Vec<_>>();

        assert_eq!(nicks, ["mel", "tomo", "sheki", "ana", "ana_away"]);
    }

    #[test]
    fn matches_known_nicks_with_irc_casemapping_and_ignores_strangers() {
        let remembered = ["{garden}".to_owned()];
        let vocabulary =
            MentionVocabulary::new(papo::Casemapping::Rfc1459, "weblounge", &remembered, &[]);

        let nicks = vocabulary
            .mentions("[Garden], ask WebLounge or gardener; [Garden] again")
            .into_iter()
            .map(|person| (person.nick, person.me))
            .collect::<Vec<_>>();

        assert_eq!(
            nicks,
            [
                ("[Garden]".to_owned(), false),
                ("WebLounge".to_owned(), true)
            ]
        );
    }
}
