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
    }

    /// Unions one peer-message fact into this conversation by msgid.
    pub fn merge_stub(&mut self, stub: MessageStub) {
        self.stubs = union_stubs(self.stubs.drain(..).chain([stub]));
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
        if self.stubs.len() <= MAX_STUBS {
            return;
        }

        let evicted = self.stubs.len() - MAX_STUBS;
        let gap_until = self.stubs[evicted - 1].time.next();
        self.stubs.drain(..evicted);
        self.merge_gap_until(gap_until);
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

#[cfg(test)]
mod tests {
    use super::{
        MAX_STUBS, MessageStub, ReadFacts, ServerTimeMs, SetOnceMerge, merge_max, merge_set_once,
    };

    fn stub(msgid: impl Into<String>, time: i64, mention: bool) -> MessageStub {
        MessageStub {
            msgid: msgid.into(),
            time: ServerTimeMs::new(time),
            mention,
        }
    }

    #[test]
    fn maximum_merge_never_moves_backwards() {
        let mut value = Some(ServerTimeMs::new(20));

        merge_max(&mut value, Some(ServerTimeMs::new(10)));
        merge_max(&mut value, Some(ServerTimeMs::new(30)));

        assert_eq!(value, Some(ServerTimeMs::new(30)));
    }

    #[test]
    fn stub_union_is_order_independent_and_keeps_monotonic_fields() {
        let push = stub("message-1", 100, true);
        let history = stub("message-1", 101, false);
        let mut push_first = ReadFacts::default();
        let mut history_first = ReadFacts::default();

        push_first.merge_stub(push.clone());
        push_first.merge_stub(history.clone());
        history_first.merge_stub(history);
        history_first.merge_stub(push);

        assert_eq!(push_first, history_first);
        assert_eq!(push_first.stubs(), [stub("message-1", 101, true)]);
    }

    #[test]
    fn mark_prunes_covered_stubs_inclusively() {
        let mut facts = ReadFacts::default();
        facts.merge_stub(stub("before", 9, false));
        facts.merge_stub(stub("tie", 10, false));
        facts.merge_stub(stub("after", 11, false));

        facts.merge_mark(ServerTimeMs::new(10));

        assert_eq!(facts.stubs(), [stub("after", 11, false)]);
    }

    #[test]
    fn cap_keeps_the_newest_stubs_and_records_the_gap() {
        let mut facts = ReadFacts::default();
        for time in 0..=MAX_STUBS {
            let time = i64::try_from(time).expect("stub cap fits i64");
            facts.merge_stub(stub(format!("message-{time}"), time, false));
        }

        assert_eq!(facts.stubs().len(), MAX_STUBS);
        assert_eq!(facts.stubs()[0].time, ServerTimeMs::new(1));
        assert_eq!(facts.gap_until(), Some(ServerTimeMs::new(1)));
    }

    #[test]
    fn fact_snapshots_merge_commutatively() {
        let mut left = ReadFacts::default();
        left.merge_mark(ServerTimeMs::new(10));
        left.merge_pending(ServerTimeMs::new(12));
        left.merge_stub(stub("later", 14, false));
        let mut right = ReadFacts::default();
        right.merge_mark(ServerTimeMs::new(11));
        right.merge_gap_until(ServerTimeMs::new(20));
        right.merge_stub(stub("mention", 13, true));

        let mut left_then_right = left.clone();
        left_then_right.merge(right.clone());
        right.merge(left);

        assert_eq!(left_then_right, right);
    }

    #[test]
    fn server_acknowledgement_clears_only_covered_pending_reads() {
        let mut facts = ReadFacts::default();
        facts.merge_pending(ServerTimeMs::new(20));

        facts.acknowledge(ServerTimeMs::new(19));
        assert_eq!(facts.pending(), Some(ServerTimeMs::new(20)));

        facts.acknowledge(ServerTimeMs::new(20));
        assert_eq!(facts.pending(), None);
    }

    #[test]
    fn set_once_accepts_retries_and_rejects_conflicts() {
        let mut value = None;

        assert_eq!(merge_set_once(&mut value, "seed"), SetOnceMerge::Set);
        assert_eq!(merge_set_once(&mut value, "seed"), SetOnceMerge::Unchanged);
        assert_eq!(merge_set_once(&mut value, "other"), SetOnceMerge::Conflict);
        assert_eq!(value, Some("seed"));
    }
}
