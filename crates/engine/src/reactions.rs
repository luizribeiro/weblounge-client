use std::collections::{BTreeMap, HashMap, VecDeque};

use crate::{BufferId, ReactionActorProjection, ReactionProjection};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
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

pub(crate) struct ReactionUpdate {
    actor: ReactionActor,
    action: ReactionAction,
    version: ReactionVersion,
}

impl ReactionUpdate {
    pub(crate) fn new(
        actor: ReactionActor,
        action: ReactionAction,
        version: ReactionVersion,
    ) -> Self {
        Self {
            actor,
            action,
            version,
        }
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct ReactionVersion {
    time_ms: i64,
    msgid: String,
}

impl ReactionVersion {
    pub(crate) fn new(time_ms: i64, msgid: impl Into<String>) -> Self {
        Self {
            time_ms,
            msgid: msgid.into(),
        }
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ReactionKey(String);

#[derive(Clone, Debug)]
struct ReactionSummary {
    ordinal: Option<u64>,
    text: String,
    facts: BTreeMap<String, ReactionFact>,
}

#[derive(Clone, Debug)]
struct ReactionFact {
    action: ReactionAction,
    actor: ReactionActor,
    preloaded: bool,
    version: ReactionVersion,
}

#[derive(Clone, Debug)]
struct TargetReactions {
    buffer_id: BufferId,
    reactions: BTreeMap<ReactionKey, ReactionSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PreloadFact {
    target: String,
    reaction: ReactionKey,
    actor: String,
}

pub(crate) struct ReactionIndex {
    targets: HashMap<String, TargetReactions>,
    preload: HashMap<BufferId, VecDeque<PreloadFact>>,
    preload_limit: usize,
    next_ordinal: u64,
}

impl Default for ReactionIndex {
    fn default() -> Self {
        Self::with_preload_limit(usize::MAX)
    }
}

impl ReactionIndex {
    pub(crate) fn with_preload_limit(preload_limit: usize) -> Self {
        Self {
            targets: HashMap::new(),
            preload: HashMap::new(),
            preload_limit,
            next_ordinal: 0,
        }
    }

    pub(crate) fn apply(
        &mut self,
        buffer_id: BufferId,
        target: &str,
        text: &str,
        update: ReactionUpdate,
        message_loaded: bool,
    ) -> bool {
        let ReactionUpdate {
            actor,
            action,
            version,
        } = update;
        if message_loaded {
            self.mark_loaded(target);
        }
        let reaction_key = ReactionKey(text.into());
        let actor_key = actor.key.clone();
        let target_reactions =
            self.targets
                .entry(target.into())
                .or_insert_with(|| TargetReactions {
                    buffer_id,
                    reactions: BTreeMap::new(),
                });
        target_reactions.buffer_id = buffer_id;
        let summary = target_reactions
            .reactions
            .entry(reaction_key.clone())
            .or_insert_with(|| ReactionSummary {
                ordinal: None,
                text: text.into(),
                facts: BTreeMap::new(),
            });
        if summary
            .facts
            .get(&actor_key)
            .is_some_and(|current| current.version >= version)
        {
            return false;
        }
        let was_preloaded = summary
            .facts
            .get(&actor_key)
            .is_some_and(|fact| fact.preloaded);
        summary.facts.insert(
            actor_key.clone(),
            ReactionFact {
                action,
                actor,
                preloaded: !message_loaded,
                version,
            },
        );
        let active = summary
            .facts
            .values()
            .any(|fact| fact.action == ReactionAction::Added);
        if active && summary.ordinal.is_none() {
            summary.ordinal = Some(self.next_ordinal);
            self.next_ordinal += 1;
        } else if !active {
            summary.ordinal = None;
        }
        if !message_loaded && !was_preloaded {
            self.preload
                .entry(buffer_id)
                .or_default()
                .push_back(PreloadFact {
                    target: target.into(),
                    reaction: reaction_key,
                    actor: actor_key,
                });
            self.enforce_preload_limit(buffer_id);
        }
        true
    }

    pub(crate) fn summaries(&self, target: &str) -> Vec<ReactionProjection> {
        let Some(target) = self.targets.get(target) else {
            return Vec::new();
        };
        let mut summaries = target
            .reactions
            .values()
            .filter(|summary| summary.ordinal.is_some())
            .collect::<Vec<_>>();
        summaries.sort_by_key(|summary| summary.ordinal);
        summaries
            .into_iter()
            .filter_map(|summary| {
                let actors = summary
                    .facts
                    .values()
                    .filter(|fact| fact.action == ReactionAction::Added)
                    .map(|fact| ReactionActorProjection {
                        nick: fact.actor.nick.clone(),
                        mine: fact.actor.mine,
                    })
                    .collect::<Vec<_>>();
                (!actors.is_empty()).then(|| ReactionProjection {
                    text: summary.text.clone(),
                    mine: actors.iter().any(|actor| actor.mine),
                    actors,
                })
            })
            .collect()
    }

    pub(crate) fn mark_loaded(&mut self, target: &str) {
        let Some(target_reactions) = self.targets.get_mut(target) else {
            return;
        };
        for fact in target_reactions
            .reactions
            .values_mut()
            .flat_map(|summary| summary.facts.values_mut())
        {
            fact.preloaded = false;
        }
        if let Some(queue) = self.preload.get_mut(&target_reactions.buffer_id) {
            queue.retain(|fact| fact.target != target);
            if queue.is_empty() {
                self.preload.remove(&target_reactions.buffer_id);
            }
        }
    }

    pub(crate) fn remove_target(&mut self, target: &str) {
        let Some(target_reactions) = self.targets.remove(target) else {
            return;
        };
        if let Some(queue) = self.preload.get_mut(&target_reactions.buffer_id) {
            queue.retain(|fact| fact.target != target);
            if queue.is_empty() {
                self.preload.remove(&target_reactions.buffer_id);
            }
        }
    }

    pub(crate) fn clear_buffer(&mut self, buffer_id: BufferId) {
        self.targets
            .retain(|_, target| target.buffer_id != buffer_id);
        self.preload.remove(&buffer_id);
    }

    fn enforce_preload_limit(&mut self, buffer_id: BufferId) {
        while self
            .preload
            .get(&buffer_id)
            .is_some_and(|queue| queue.len() > self.preload_limit)
        {
            let Some(oldest) = self
                .preload
                .get_mut(&buffer_id)
                .and_then(VecDeque::pop_front)
            else {
                break;
            };
            self.remove_preload_fact(&oldest);
        }
        if self.preload.get(&buffer_id).is_some_and(VecDeque::is_empty) {
            self.preload.remove(&buffer_id);
        }
    }

    fn remove_preload_fact(&mut self, fact: &PreloadFact) {
        let Some(target) = self.targets.get_mut(&fact.target) else {
            return;
        };
        let Some(summary) = target.reactions.get_mut(&fact.reaction) else {
            return;
        };
        if summary
            .facts
            .get(&fact.actor)
            .is_some_and(|current| current.preloaded)
        {
            summary.facts.remove(&fact.actor);
        }
        if summary.facts.is_empty() {
            target.reactions.remove(&fact.reaction);
        }
        if target.reactions.is_empty() {
            self.targets.remove(&fact.target);
        }
    }

    #[cfg(test)]
    fn preload_fact_count(&self, buffer_id: BufferId) -> usize {
        self.preload.get(&buffer_id).map_or(0, VecDeque::len)
    }

    #[cfg(test)]
    pub(crate) fn contains_target(&self, target: &str) -> bool {
        self.targets.contains_key(target)
    }
}

#[cfg(test)]
mod tests {
    use super::{ReactionAction, ReactionActor, ReactionIndex, ReactionUpdate, ReactionVersion};
    use crate::BufferId;

    fn actor(key: &str, nick: &str, mine: bool) -> ReactionActor {
        ReactionActor {
            key: key.into(),
            nick: nick.into(),
            mine,
        }
    }

    fn update(
        actor: ReactionActor,
        action: ReactionAction,
        version: ReactionVersion,
    ) -> ReactionUpdate {
        ReactionUpdate::new(actor, action, version)
    }

    #[test]
    fn adds_reactions_in_first_reaction_order() {
        let mut index = ReactionIndex::default();

        assert!(index.apply(
            BufferId(2),
            "message",
            "🎉",
            update(
                actor("ana", "ana", false),
                ReactionAction::Added,
                ReactionVersion::new(1, "party"),
            ),
            false,
        ));
        assert!(index.apply(
            BufferId(2),
            "message",
            "👍",
            update(
                actor("me", "luiz", true),
                ReactionAction::Added,
                ReactionVersion::new(2, "thumb"),
            ),
            false,
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
            BufferId(2),
            "message",
            "👍",
            update(
                actor("ana", "ana", false),
                ReactionAction::Added,
                ReactionVersion::new(1, "ana-add"),
            ),
            false,
        );
        index.apply(
            BufferId(2),
            "message",
            "👍",
            update(
                actor("bruno", "bruno", false),
                ReactionAction::Added,
                ReactionVersion::new(1, "bruno-add"),
            ),
            false,
        );

        assert!(index.apply(
            BufferId(2),
            "message",
            "👍",
            update(
                actor("ana", "ana", false),
                ReactionAction::Removed,
                ReactionVersion::new(2, "ana-remove"),
            ),
            false,
        ));
        assert_eq!(index.summaries("message")[0].actors.len(), 1);
        assert!(index.apply(
            BufferId(2),
            "message",
            "👍",
            update(
                actor("bruno", "bruno", false),
                ReactionAction::Removed,
                ReactionVersion::new(2, "bruno-remove"),
            ),
            false,
        ));
        assert!(index.summaries("message").is_empty());
    }

    #[test]
    fn ignores_duplicate_additions() {
        let mut index = ReactionIndex::default();
        let ana = actor("ana", "ana", false);

        assert!(index.apply(
            BufferId(2),
            "message",
            "👍",
            update(
                ana.clone(),
                ReactionAction::Added,
                ReactionVersion::new(1, "add"),
            ),
            false,
        ));
        assert!(!index.apply(
            BufferId(2),
            "message",
            "👍",
            update(ana, ReactionAction::Added, ReactionVersion::new(1, "add"),),
            false,
        ));
        assert_eq!(index.summaries("message")[0].actors.len(), 1);
    }

    #[test]
    fn deduplicates_history_and_live_overlap() {
        let mut index = ReactionIndex::default();

        index.apply(
            BufferId(2),
            "message",
            "❤️",
            update(
                actor("ana", "ana", false),
                ReactionAction::Added,
                ReactionVersion::new(1, "same-line"),
            ),
            false,
        );
        index.apply(
            BufferId(2),
            "message",
            "❤️",
            update(
                actor("ana", "ana", false),
                ReactionAction::Added,
                ReactionVersion::new(1, "same-line"),
            ),
            false,
        );

        assert_eq!(index.summaries("message")[0].actors.len(), 1);
    }

    #[test]
    fn retains_a_reaction_until_its_message_arrives() {
        let mut index = ReactionIndex::default();

        index.apply(
            BufferId(2),
            "unknown",
            "👀",
            update(
                actor("ana", "ana", false),
                ReactionAction::Added,
                ReactionVersion::new(1, "eyes"),
            ),
            false,
        );

        assert_eq!(index.summaries("unknown")[0].text, "👀");
    }

    #[test]
    fn newer_removal_blocks_an_older_addition() {
        let mut index = ReactionIndex::with_preload_limit(10);
        let ana = actor("ana", "ana", false);

        index.apply(
            BufferId(2),
            "message",
            "👍",
            update(
                ana.clone(),
                ReactionAction::Removed,
                ReactionVersion::new(2, "remove"),
            ),
            false,
        );
        index.apply(
            BufferId(2),
            "message",
            "👍",
            update(ana, ReactionAction::Added, ReactionVersion::new(1, "add")),
            false,
        );

        assert!(index.summaries("message").is_empty());
    }

    #[test]
    fn duplicate_add_replay_cannot_undo_a_newer_removal() {
        let mut index = ReactionIndex::with_preload_limit(10);
        let ana = actor("ana", "ana", false);
        for (action, time, msgid) in [
            (ReactionAction::Added, 1, "add"),
            (ReactionAction::Removed, 2, "remove"),
            (ReactionAction::Added, 1, "add"),
        ] {
            index.apply(
                BufferId(2),
                "message",
                "👍",
                update(ana.clone(), action, ReactionVersion::new(time, msgid)),
                false,
            );
        }

        assert!(index.summaries("message").is_empty());
    }

    #[test]
    fn bounds_facts_for_messages_that_have_not_loaded() {
        let mut index = ReactionIndex::with_preload_limit(2);
        for value in ["first", "second", "third"] {
            index.apply(
                BufferId(2),
                value,
                "👍",
                update(
                    actor("ana", "ana", false),
                    ReactionAction::Added,
                    ReactionVersion::new(1, value),
                ),
                false,
            );
        }

        assert!(index.summaries("first").is_empty());
        assert_eq!(index.preload_fact_count(BufferId(2)), 2);
    }
}
