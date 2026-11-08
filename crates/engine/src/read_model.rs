//! Order-independent read-state facts and projections.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The maximum number of known unread message facts retained per conversation.
pub const MAX_STUBS: usize = 100;

/// A server timestamp represented without sub-millisecond precision loss.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ServerTimeMs(i64);

impl ServerTimeMs {
    /// Creates a timestamp from its millisecond value.
    #[must_use]
    pub const fn new(value: i64) -> Self {
        Self(value)
    }

    /// Returns the represented millisecond value.
    #[must_use]
    pub const fn value(self) -> i64 {
        self.0
    }

    fn next(self) -> Self {
        Self(self.0.saturating_add(1))
    }
}

/// The peer-message metadata needed to derive unread state.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MessageStub {
    /// The server message identifier used for deduplication.
    pub msgid: String,
    /// The greatest observed server time for this message.
    pub time: ServerTimeMs,
    /// Whether this message contributes mention severity.
    pub mention: bool,
}

/// Persistable, order-independent facts for one conversation.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReadFacts {
    mark: Option<ServerTimeMs>,
    pending: Option<ServerTimeMs>,
    stubs: Vec<MessageStub>,
    gap_until: Option<ServerTimeMs>,
}

impl ReadFacts {
    /// Returns the greatest known read mark.
    #[must_use]
    pub const fn mark(&self) -> Option<ServerTimeMs> {
        self.mark
    }

    /// Returns the greatest local read awaiting server acknowledgement.
    #[must_use]
    pub const fn pending(&self) -> Option<ServerTimeMs> {
        self.pending
    }

    /// Returns peer-message facts in server-time and msgid order.
    #[must_use]
    pub fn stubs(&self) -> &[MessageStub] {
        &self.stubs
    }

    /// Returns the upper edge of a known incomplete unread region.
    #[must_use]
    pub const fn gap_until(&self) -> Option<ServerTimeMs> {
        self.gap_until
    }

    /// Raises the read mark and removes peer-message facts it covers.
    pub fn merge_mark(&mut self, mark: ServerTimeMs) {
        merge_max(&mut self.mark, Some(mark));
        self.normalize_stubs();
    }

    /// Raises the greatest local read awaiting server acknowledgement.
    pub fn merge_pending(&mut self, pending: ServerTimeMs) {
        merge_max(&mut self.pending, Some(pending));
    }

    /// Clears a pending advance covered by a server acknowledgement.
    pub fn acknowledge(&mut self, acknowledged: ServerTimeMs) {
        self.merge_mark(acknowledged);
        if self.pending.is_some_and(|pending| pending <= acknowledged) {
            self.pending = None;
        }
    }

    /// Raises the upper edge of a known incomplete unread region.
    pub fn merge_gap_until(&mut self, gap_until: ServerTimeMs) {
        merge_max(&mut self.gap_until, Some(gap_until));
        self.normalize_gap();
    }

    /// Unions one peer-message fact into this conversation by msgid.
    pub fn merge_stub(&mut self, stub: MessageStub) {
        self.stubs = union_stubs(self.stubs.drain(..).chain([stub]));
        self.normalize_stubs();
    }

    /// Replaces a provisional peer-message fact with its authoritative copy.
    pub fn replace_stub(&mut self, stub: MessageStub) {
        self.stubs.retain(|known| known.msgid != stub.msgid);
        self.stubs.push(stub);
        self.stubs.sort_unstable_by(|left, right| {
            left.time
                .cmp(&right.time)
                .then_with(|| left.msgid.cmp(&right.msgid))
        });
        self.normalize_stubs();
    }

    /// Merges another snapshot of the same conversation into this one.
    pub fn merge(&mut self, other: Self) {
        merge_max(&mut self.mark, other.mark);
        merge_max(&mut self.pending, other.pending);
        merge_max(&mut self.gap_until, other.gap_until);
        self.stubs = union_stubs(self.stubs.drain(..).chain(other.stubs));
        self.normalize_stubs();
    }

    fn normalize_stubs(&mut self) {
        if let Some(mark) = self.mark {
            self.stubs.retain(|stub| stub.time > mark);
        }
        self.normalize_gap();
        if self.stubs.len() <= MAX_STUBS {
            return;
        }

        let evicted = self.stubs.len() - MAX_STUBS;
        let gap_until = self.stubs[evicted - 1].time.next();
        self.stubs.drain(..evicted);
        self.merge_gap_until(gap_until);
    }

    fn normalize_gap(&mut self) {
        if self
            .mark
            .zip(self.gap_until)
            .is_some_and(|(mark, gap_until)| mark >= gap_until)
        {
            self.gap_until = None;
        }
    }
}

/// Merges an optional ordered fact by retaining its greatest value.
pub fn merge_max<T: Ord>(current: &mut Option<T>, incoming: Option<T>) {
    if incoming.as_ref() > current.as_ref() {
        *current = incoming;
    }
}

/// The result of applying a value that may be established only once.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SetOnceMerge {
    /// The empty slot accepted the value.
    Set,
    /// The slot already held the same value.
    Unchanged,
    /// The slot held a different value and was not modified.
    Conflict,
}

/// Sets an empty slot, accepts an identical retry, and rejects a conflicting value.
pub fn merge_set_once<T: Eq>(current: &mut Option<T>, incoming: T) -> SetOnceMerge {
    match current {
        None => {
            *current = Some(incoming);
            SetOnceMerge::Set
        }
        Some(existing) if *existing == incoming => SetOnceMerge::Unchanged,
        Some(_) => SetOnceMerge::Conflict,
    }
}

fn union_stubs(stubs: impl IntoIterator<Item = MessageStub>) -> Vec<MessageStub> {
    let mut by_msgid = BTreeMap::<String, MessageStub>::new();
    for stub in stubs {
        by_msgid
            .entry(stub.msgid.clone())
            .and_modify(|known| {
                known.time = known.time.max(stub.time);
                known.mention |= stub.mention;
            })
            .or_insert(stub);
    }

    let mut stubs: Vec<_> = by_msgid.into_values().collect();
    stubs.sort_unstable_by(|left, right| {
        left.time
            .cmp(&right.time)
            .then_with(|| left.msgid.cmp(&right.msgid))
    });
    stubs
}

/// The projected severity of an in-app conversation badge.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BadgeKind {
    /// Known unread messages without a projected mention.
    Unread,
    /// At least one known unread message is a projected mention.
    Mention,
}

/// The visible count on an in-app conversation badge.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BadgeCount {
    /// An exact known unread count.
    Exact(usize),
    /// The unread region is incomplete or has more than 99 known messages.
    #[serde(rename = "more_than_99")]
    MoreThan99,
}

/// An in-app conversation badge derived from read facts.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConversationBadge {
    /// The count text to display.
    pub count: BadgeCount,
    /// The badge's visual and accessible severity.
    pub kind: BadgeKind,
}

/// The kind used by the operating-system app-badge policy.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationKind {
    /// A channel conversation.
    Channel,
    /// A direct-message conversation.
    Direct,
}

/// A conversation included in the operating-system app-badge projection.
pub struct AppBadgeConversation<'a> {
    /// Whether the conversation is a channel or direct message.
    pub kind: ConversationKind,
    /// The conversation's read facts.
    pub facts: &'a ReadFacts,
    /// Whether channel mention severity is muted.
    pub muted: bool,
}

/// The placement of the frozen unread divider.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "placement")]
pub enum Divider {
    /// Missing messages may precede the loaded unread stubs.
    AtTop,
    /// The divider belongs immediately before this peer message.
    Before {
        /// The first known peer message after the frozen divider mark.
        msgid: String,
    },
}

/// Counts known peer messages strictly after the conversation's mark.
#[must_use]
pub fn unread_count(facts: &ReadFacts) -> usize {
    facts
        .stubs
        .iter()
        .filter(|stub| facts.mark.is_none_or(|mark| stub.time > mark))
        .count()
}

/// Counts known unread mentions, or returns zero for a muted channel.
#[must_use]
pub fn mention_count(facts: &ReadFacts, muted: bool) -> usize {
    if muted {
        return 0;
    }
    facts
        .stubs
        .iter()
        .filter(|stub| stub.mention && facts.mark.is_none_or(|mark| stub.time > mark))
        .count()
}

/// Returns whether the unread region may contain messages absent from the stub index.
#[must_use]
pub fn has_unread_gap(facts: &ReadFacts) -> bool {
    facts
        .gap_until
        .is_some_and(|gap| facts.mark.is_none_or(|mark| gap > mark))
}

/// Derives the in-app badge from known peer-message facts.
#[must_use]
pub fn conversation_badge(facts: &ReadFacts, muted: bool) -> Option<ConversationBadge> {
    let unread = unread_count(facts);
    let has_gap = has_unread_gap(facts);
    if unread == 0 && !has_gap {
        return None;
    }

    Some(ConversationBadge {
        count: if unread > 99 || has_gap {
            BadgeCount::MoreThan99
        } else {
            BadgeCount::Exact(unread)
        },
        kind: if mention_count(facts, muted) > 0 {
            BadgeKind::Mention
        } else {
            BadgeKind::Unread
        },
    })
}

/// Derives the frozen unread divider from an explicit pane mark.
#[must_use]
pub fn divider(facts: &ReadFacts, divider_mark: Option<ServerTimeMs>) -> Option<Divider> {
    let mark = divider_mark?;
    if facts.gap_until.is_some_and(|gap| gap > mark) {
        return Some(Divider::AtTop);
    }

    facts
        .stubs
        .iter()
        .find(|stub| stub.time > mark)
        .map(|stub| Divider::Before {
            msgid: stub.msgid.clone(),
        })
}

/// Sums direct unread messages and channel mentions for the operating-system badge.
#[must_use]
pub fn app_badge_count<'a>(
    conversations: impl IntoIterator<Item = AppBadgeConversation<'a>>,
) -> usize {
    conversations.into_iter().fold(0, |total, conversation| {
        let contribution = match conversation.kind {
            ConversationKind::Channel => mention_count(conversation.facts, conversation.muted),
            ConversationKind::Direct => unread_count(conversation.facts),
        };
        total.saturating_add(contribution)
    })
}

/// Returns whether a conversation mark covers an operating-system notification.
#[must_use]
pub fn should_close_notification<K: Eq>(
    notification_conversation: &K,
    notification_time: ServerTimeMs,
    conversation: &K,
    mark: Option<ServerTimeMs>,
) -> bool {
    notification_conversation == conversation && mark.is_some_and(|mark| notification_time <= mark)
}

#[cfg(test)]
mod golden_tests;
#[cfg(test)]
mod property_tests;
#[cfg(test)]
mod tests;
