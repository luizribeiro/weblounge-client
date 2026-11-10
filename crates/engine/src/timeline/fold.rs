#![allow(missing_docs)]

use std::collections::HashSet;

use crate::{MessageId, MessageProjection};

use super::{Actor, GapProjection, LineEvent, LocalDay, ModeProjection, OrderKey, TimelineError};

/// One engine record before run folding.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimelineRecord {
    pub id: MessageId,
    pub order: OrderKey,
    pub day: LocalDay,
    pub body: RecordBody,
}

/// Content retained by one engine record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RecordBody {
    Chat(ChatRecord),
    Fold(FoldEvent),
    Line(LineEvent),
    Gap(GapProjection),
}

/// Existing chat projection retained until the message-family migration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChatRecord {
    pub projection: MessageProjection,
}

/// An event eligible to join a collapsed run.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FoldEvent {
    Joined(Who),
    Parted(Who, Option<String>),
    Quit(Who, Option<String>, Option<SplitServers>),
    Nick {
        old: Who,
        new: Who,
    },
    Modes {
        actor: Actor,
        changes: Vec<ModeProjection>,
    },
    Invited {
        actor: Actor,
        subject: Who,
    },
}

/// IRC identity facts needed by the later collapsing projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Who {
    pub nick: String,
    pub own: bool,
    pub msgid: Option<String>,
}

/// Servers attached to a papo-confirmed netsplit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SplitServers {
    pub left: String,
    pub right: String,
}

/// A non-empty run of foldable events.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FoldRun {
    first: FoldEvent,
    rest: Vec<FoldEvent>,
}

impl FoldRun {
    /// Returns the events in deterministic fold order.
    pub fn events(&self) -> impl Iterator<Item = &FoldEvent> {
        std::iter::once(&self.first).chain(&self.rest)
    }
}

/// One item boundary produced by the pure fold.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FoldedItem {
    pub id: MessageId,
    pub order: OrderKey,
    pub day: LocalDay,
    pub body: FoldedBody,
    record_ids: Vec<MessageId>,
}

impl FoldedItem {
    /// Returns every source record represented by this item.
    #[must_use]
    pub fn record_ids(&self) -> &[MessageId] {
        &self.record_ids
    }
}

/// Content at one current fold boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FoldedBody {
    Chat(ChatRecord),
    Run(FoldRun),
    Line(LineEvent),
    Gap(GapProjection),
}

/// Folds sorted records once. Batch 1a deliberately leaves each fold event standalone.
///
/// # Errors
///
/// Returns [`TimelineError`] when identities repeat or records are not strictly ordered.
pub fn fold(records: &[TimelineRecord]) -> Result<Vec<FoldedItem>, TimelineError> {
    validate(records)?;
    Ok(records.iter().cloned().map(FoldedItem::from).collect())
}

fn validate(records: &[TimelineRecord]) -> Result<(), TimelineError> {
    if records
        .windows(2)
        .any(|pair| pair[0].order >= pair[1].order)
    {
        return Err(TimelineError::UnsortedRecords);
    }
    let mut ids = HashSet::with_capacity(records.len());
    for record in records {
        if !ids.insert(record.id) {
            return Err(TimelineError::DuplicateId(record.id));
        }
    }
    Ok(())
}

impl From<TimelineRecord> for FoldedItem {
    fn from(record: TimelineRecord) -> Self {
        let body = match record.body {
            RecordBody::Chat(chat) => FoldedBody::Chat(chat),
            RecordBody::Fold(event) => FoldedBody::Run(FoldRun {
                first: event,
                rest: Vec::new(),
            }),
            RecordBody::Line(event) => FoldedBody::Line(event),
            RecordBody::Gap(gap) => FoldedBody::Gap(gap),
        };
        Self {
            id: record.id,
            order: record.order,
            day: record.day,
            body,
            record_ids: vec![record.id],
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::MessageId;

    use super::{FoldEvent, FoldedBody, RecordBody, TimelineRecord, Who, fold};
    use crate::timeline::{LocalDay, OrderKey, TimelineError};

    fn joined(id: u64, primary_ms: i64) -> TimelineRecord {
        TimelineRecord {
            id: MessageId(id),
            order: OrderKey::new(primary_ms, primary_ms + 10, id),
            day: LocalDay(1),
            body: RecordBody::Fold(FoldEvent::Joined(Who {
                nick: format!("nick-{id}"),
                own: false,
                msgid: Some(format!("msg-{id}")),
            })),
        }
    }

    #[test]
    fn adjacent_memberships_are_standalone_in_batch_1a() {
        let records = [joined(4, 10), joined(7, 20)];
        let items = fold(&records).expect("valid records");

        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, MessageId(4));
        assert_eq!(items[0].record_ids(), [MessageId(4)]);
        assert!(matches!(items[0].body, FoldedBody::Run(_)));
        assert_eq!(items[1].id, MessageId(7));
    }

    #[test]
    fn fold_rejects_ambiguous_input_order_and_identity() {
        assert_eq!(
            fold(&[joined(1, 20), joined(2, 10)]),
            Err(TimelineError::UnsortedRecords),
        );
        assert_eq!(
            fold(&[joined(1, 10), joined(1, 20)]),
            Err(TimelineError::DuplicateId(MessageId(1))),
        );
    }
}
