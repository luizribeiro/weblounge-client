use std::collections::{BTreeMap, HashMap, VecDeque};

use crate::{BufferId, ReactionActorProjection, ReactionDelivery, ReactionProjection};

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
    own: Option<OwnChange>,
}

#[derive(Clone, Debug)]
struct OwnChange {
    action: ReactionAction,
    delivery: ReactionDelivery,
    nick: String,
}

impl ReactionSummary {
    fn new(text: &str) -> Self {
        Self {
            ordinal: None,
            text: text.into(),
            facts: BTreeMap::new(),
            own: None,
        }
    }

    fn confirmed_mine(&self) -> bool {
        self.facts
            .values()
            .any(|fact| fact.actor.mine && fact.action == ReactionAction::Added)
    }

    fn assign_ordinal(&mut self, next_ordinal: &mut u64) {
        let retained = self.own.is_some()
            || self
                .facts
                .values()
                .any(|fact| fact.action == ReactionAction::Added);
        if retained && self.ordinal.is_none() {
            self.ordinal = Some(*next_ordinal);
            *next_ordinal += 1;
        } else if !retained {
            self.ordinal = None;
        }
    }

    fn projection(&self) -> Option<ReactionProjection> {
        let mut actors = self
            .facts
            .values()
            .filter(|fact| fact.action == ReactionAction::Added)
            .map(|fact| ReactionActorProjection {
                nick: fact.actor.nick.clone(),
                mine: fact.actor.mine,
            })
            .collect::<Vec<_>>();
        let own_delivery = match &self.own {
            None => None,
            Some(own) if own.action == ReactionAction::Added && self.confirmed_mine() => None,
            Some(own) if own.action == ReactionAction::Added => {
                actors.push(ReactionActorProjection {
                    nick: own.nick.clone(),
                    mine: true,
                });
                Some(own.delivery)
            }
            Some(own) if own.delivery == ReactionDelivery::Sending => {
                actors.retain(|actor| !actor.mine);
                None
            }
            Some(own) => Some(own.delivery),
        };
        (!actors.is_empty()).then(|| ReactionProjection {
            text: self.text.clone(),
            mine: actors.iter().any(|actor| actor.mine),
            actors,
            own_delivery,
        })
    }
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
            .or_insert_with(|| ReactionSummary::new(text));
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
        if actor.mine && summary.own.as_ref().is_some_and(|own| own.action == action) {
            summary.own = None;
        }
        summary.facts.insert(
            actor_key.clone(),
            ReactionFact {
                action,
                actor,
                preloaded: !message_loaded,
                version,
            },
        );
        summary.assign_ordinal(&mut self.next_ordinal);
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
            .filter_map(ReactionSummary::projection)
            .collect()
    }

    /// Starts this account's change to `text` on a loaded message and returns the action to send.
    ///
    /// A failed change is retried as-is; a change still sending is not sent twice.
    pub(crate) fn toggle_own(
        &mut self,
        buffer_id: BufferId,
        target: &str,
        text: &str,
        nick: &str,
    ) -> Option<ReactionAction> {
        let summary = self
            .targets
            .entry(target.into())
            .or_insert_with(|| TargetReactions {
                buffer_id,
                reactions: BTreeMap::new(),
            })
            .reactions
            .entry(ReactionKey(text.into()))
            .or_insert_with(|| ReactionSummary::new(text));
        let action = match &summary.own {
            Some(own) if own.delivery == ReactionDelivery::Sending => return None,
            Some(own) => own.action,
            None if summary.confirmed_mine() => ReactionAction::Removed,
            None => ReactionAction::Added,
        };
        summary.own = Some(OwnChange {
            action,
            delivery: ReactionDelivery::Sending,
            nick: nick.into(),
        });
        summary.assign_ordinal(&mut self.next_ordinal);
        Some(action)
    }

    /// Marks this account's still-unconfirmed `action` on `text` as failed.
    pub(crate) fn fail_own(&mut self, target: &str, text: &str, action: ReactionAction) -> bool {
        let Some(own) = self
            .targets
            .get_mut(target)
            .and_then(|target| target.reactions.get_mut(&ReactionKey(text.into())))
            .and_then(|summary| summary.own.as_mut())
            .filter(|own| own.action == action && own.delivery == ReactionDelivery::Sending)
        else {
            return false;
        };
        own.delivery = ReactionDelivery::Failed;
        true
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
        if summary.facts.is_empty() && summary.own.is_none() {
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
    use crate::{BufferId, ReactionDelivery};

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

    fn confirm(index: &mut ReactionIndex, actor: ReactionActor, action: ReactionAction, time: i64) {
        index.apply(
            BufferId(2),
            "message",
            "👍",
            update(
                actor,
                action,
                ReactionVersion::new(time, format!("own-{time}")),
            ),
            true,
        );
    }

    #[test]
    fn own_addition_shows_as_sending_until_its_echo() {
        let mut index = ReactionIndex::default();
        confirm(
            &mut index,
            actor("ana", "ana", false),
            ReactionAction::Added,
            1,
        );

        assert_eq!(
            index.toggle_own(BufferId(2), "message", "👍", "luiz"),
            Some(ReactionAction::Added)
        );
        let sending = &index.summaries("message")[0];
        assert_eq!(sending.own_delivery, Some(ReactionDelivery::Sending));
        assert!(sending.mine);
        assert_eq!(sending.actors.len(), 2);

        confirm(
            &mut index,
            actor("me", "luiz", true),
            ReactionAction::Added,
            2,
        );
        let confirmed = &index.summaries("message")[0];
        assert_eq!(confirmed.own_delivery, None);
        assert_eq!(confirmed.actors.len(), 2);
    }

    #[test]
    fn own_removal_hides_the_actor_until_its_echo() {
        let mut index = ReactionIndex::default();
        confirm(
            &mut index,
            actor("me", "luiz", true),
            ReactionAction::Added,
            1,
        );

        assert_eq!(
            index.toggle_own(BufferId(2), "message", "👍", "luiz"),
            Some(ReactionAction::Removed)
        );
        assert!(index.summaries("message").is_empty());

        confirm(
            &mut index,
            actor("me", "luiz", true),
            ReactionAction::Removed,
            2,
        );
        assert!(index.summaries("message").is_empty());
        assert_eq!(
            index.toggle_own(BufferId(2), "message", "👍", "luiz"),
            Some(ReactionAction::Added)
        );
    }

    #[test]
    fn a_sending_addition_never_duplicates_a_confirmed_own_actor() {
        let mut index = ReactionIndex::default();
        index.toggle_own(BufferId(2), "message", "👍", "luiz");

        index.apply(
            BufferId(2),
            "message",
            "👍",
            update(
                actor("me", "luiz", true),
                ReactionAction::Removed,
                ReactionVersion::new(1, "other-device-remove"),
            ),
            true,
        );
        index.apply(
            BufferId(2),
            "message",
            "👍",
            update(
                actor("me", "luiz", true),
                ReactionAction::Added,
                ReactionVersion::new(2, "other-device-add"),
            ),
            true,
        );

        let summary = &index.summaries("message")[0];
        assert_eq!(summary.actors.len(), 1);
        assert_eq!(summary.own_delivery, None);
    }

    #[test]
    fn a_sending_change_is_not_sent_twice() {
        let mut index = ReactionIndex::default();

        index.toggle_own(BufferId(2), "message", "👍", "luiz");

        assert_eq!(index.toggle_own(BufferId(2), "message", "👍", "luiz"), None);
    }

    #[test]
    fn a_failed_change_keeps_its_chip_and_retries_the_same_action() {
        let mut index = ReactionIndex::default();
        index.toggle_own(BufferId(2), "message", "👍", "luiz");

        assert!(index.fail_own("message", "👍", ReactionAction::Added));
        assert_eq!(
            index.summaries("message")[0].own_delivery,
            Some(ReactionDelivery::Failed)
        );
        assert_eq!(
            index.toggle_own(BufferId(2), "message", "👍", "luiz"),
            Some(ReactionAction::Added)
        );
        assert_eq!(
            index.summaries("message")[0].own_delivery,
            Some(ReactionDelivery::Sending)
        );
    }

    #[test]
    fn a_failed_removal_restores_the_own_chip_as_failed() {
        let mut index = ReactionIndex::default();
        confirm(
            &mut index,
            actor("me", "luiz", true),
            ReactionAction::Added,
            1,
        );
        index.toggle_own(BufferId(2), "message", "👍", "luiz");

        assert!(index.fail_own("message", "👍", ReactionAction::Removed));

        let failed = &index.summaries("message")[0];
        assert!(failed.mine);
        assert_eq!(failed.own_delivery, Some(ReactionDelivery::Failed));
    }

    #[test]
    fn a_failure_after_the_echo_changes_nothing() {
        let mut index = ReactionIndex::default();
        index.toggle_own(BufferId(2), "message", "👍", "luiz");
        confirm(
            &mut index,
            actor("me", "luiz", true),
            ReactionAction::Added,
            1,
        );

        assert!(!index.fail_own("message", "👍", ReactionAction::Added));
        assert_eq!(index.summaries("message")[0].own_delivery, None);
    }

    #[test]
    fn a_new_own_reaction_follows_existing_chips() {
        let mut index = ReactionIndex::default();
        confirm(
            &mut index,
            actor("ana", "ana", false),
            ReactionAction::Added,
            1,
        );

        index.toggle_own(BufferId(2), "message", "🎉", "luiz");

        assert_eq!(
            index
                .summaries("message")
                .iter()
                .map(|item| item.text.as_str())
                .collect::<Vec<_>>(),
            ["👍", "🎉"]
        );
    }
}
