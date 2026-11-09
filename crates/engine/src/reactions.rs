#![expect(dead_code, reason = "runtime wiring lands in the next commit")]

use std::collections::{BTreeMap, HashMap};

use crate::{ReactionActorProjection, ReactionProjection};

#[derive(Clone, Copy, Debug)]
pub(crate) enum ReactionAction {
    Added,
    Removed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ReactionActor {
    pub(crate) key: String,
    pub(crate) nick: String,
    pub(crate) mine: bool,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ReactionKey(String);

#[derive(Clone, Debug)]
struct ReactionSummary {
    ordinal: u64,
    text: String,
    actors: BTreeMap<String, ReactionActor>,
}

#[derive(Default)]
pub(crate) struct ReactionIndex {
    targets: HashMap<String, BTreeMap<ReactionKey, ReactionSummary>>,
    next_ordinal: u64,
}

impl ReactionIndex {
    pub(crate) fn apply(
        &mut self,
        target: &str,
        text: &str,
        actor: ReactionActor,
        action: ReactionAction,
    ) -> bool {
        match action {
            ReactionAction::Added => self.add(target, text, actor),
            ReactionAction::Removed => self.remove(target, text, &actor.key),
        }
    }

    pub(crate) fn summaries(&self, target: &str) -> Vec<ReactionProjection> {
        let Some(reactions) = self.targets.get(target) else {
            return Vec::new();
        };
        let mut summaries = reactions.values().collect::<Vec<_>>();
        summaries.sort_by_key(|summary| summary.ordinal);
        summaries
            .into_iter()
            .map(|summary| ReactionProjection {
                text: summary.text.clone(),
                actors: summary
                    .actors
                    .values()
                    .map(|actor| ReactionActorProjection {
                        nick: actor.nick.clone(),
                        mine: actor.mine,
                    })
                    .collect(),
                mine: summary.actors.values().any(|actor| actor.mine),
            })
            .collect()
    }

    fn add(&mut self, target: &str, text: &str, actor: ReactionActor) -> bool {
        let reactions = self.targets.entry(target.into()).or_default();
        let summary = reactions
            .entry(ReactionKey(text.into()))
            .or_insert_with(|| {
                let ordinal = self.next_ordinal;
                self.next_ordinal += 1;
                ReactionSummary {
                    ordinal,
                    text: text.into(),
                    actors: BTreeMap::new(),
                }
            });
        if summary.actors.get(&actor.key) == Some(&actor) {
            return false;
        }
        summary.actors.insert(actor.key.clone(), actor);
        true
    }

    fn remove(&mut self, target: &str, text: &str, actor_key: &str) -> bool {
        let key = ReactionKey(text.into());
        let Some(reactions) = self.targets.get_mut(target) else {
            return false;
        };
        let Some(summary) = reactions.get_mut(&key) else {
            return false;
        };
        if summary.actors.remove(actor_key).is_none() {
            return false;
        }
        if summary.actors.is_empty() {
            reactions.remove(&key);
        }
        if reactions.is_empty() {
            self.targets.remove(target);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{ReactionAction, ReactionActor, ReactionIndex};

    fn actor(key: &str, nick: &str, mine: bool) -> ReactionActor {
        ReactionActor {
            key: key.into(),
            nick: nick.into(),
            mine,
        }
    }

    #[test]
    fn adds_reactions_in_first_reaction_order() {
        let mut index = ReactionIndex::default();

        assert!(index.apply(
            "message",
            "🎉",
            actor("ana", "ana", false),
            ReactionAction::Added
        ));
        assert!(index.apply(
            "message",
            "👍",
            actor("me", "luiz", true),
            ReactionAction::Added
        ));

        let summaries = index.summaries("message");
        assert_eq!(
            summaries
                .iter()
                .map(|item| item.text.as_str())
                .collect::<Vec<_>>(),
            ["🎉", "👍"]
        );
        assert_eq!(summaries[1].actors[0].nick, "luiz");
        assert!(summaries[1].mine);
    }

    #[test]
    fn removes_an_actor_and_empty_reaction() {
        let mut index = ReactionIndex::default();
        index.apply(
            "message",
            "👍",
            actor("ana", "ana", false),
            ReactionAction::Added,
        );
        index.apply(
            "message",
            "👍",
            actor("bruno", "bruno", false),
            ReactionAction::Added,
        );

        assert!(index.apply(
            "message",
            "👍",
            actor("ana", "ana", false),
            ReactionAction::Removed
        ));
        assert_eq!(index.summaries("message")[0].actors.len(), 1);
        assert!(index.apply(
            "message",
            "👍",
            actor("bruno", "bruno", false),
            ReactionAction::Removed
        ));
        assert!(index.summaries("message").is_empty());
    }

    #[test]
    fn ignores_duplicate_additions() {
        let mut index = ReactionIndex::default();
        let ana = actor("ana", "ana", false);

        assert!(index.apply("message", "👍", ana.clone(), ReactionAction::Added));
        assert!(!index.apply("message", "👍", ana, ReactionAction::Added));
        assert_eq!(index.summaries("message")[0].actors.len(), 1);
    }

    #[test]
    fn deduplicates_history_and_live_overlap() {
        let mut index = ReactionIndex::default();

        index.apply(
            "message",
            "❤️",
            actor("ana", "ana", false),
            ReactionAction::Added,
        );
        index.apply(
            "message",
            "❤️",
            actor("ana", "ana", false),
            ReactionAction::Added,
        );

        assert_eq!(index.summaries("message")[0].actors.len(), 1);
    }

    #[test]
    fn retains_a_reaction_until_its_message_arrives() {
        let mut index = ReactionIndex::default();

        index.apply(
            "unknown",
            "👀",
            actor("ana", "ana", false),
            ReactionAction::Added,
        );

        assert_eq!(index.summaries("unknown")[0].text, "👀");
    }
}
