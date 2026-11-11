#![allow(missing_docs)]

use std::collections::HashSet;

use crate::{MessageId, MessageProjection};

use super::{
    Actor, FoldRun, GapProjection, LineEvent, LocalDay, ModeProjection, OrderKey, TimelineError,
    collapse_run,
};

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
    pub key: String,
    pub nick_color_index: u32,
    pub own: bool,
    pub msgid: Option<String>,
}

/// Servers attached to a papo-confirmed netsplit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SplitServers {
    pub left: String,
    pub right: String,
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

/// Folds adjacent foldable records on the same local day in one pass.
///
/// # Errors
///
/// Returns [`TimelineError`] when identities repeat or records are not strictly ordered.
pub fn fold(records: &[TimelineRecord]) -> Result<Vec<FoldedItem>, TimelineError> {
    validate(records)?;
    let mut items = Vec::with_capacity(records.len());
    let mut run = Vec::new();
    for record in records {
        match &record.body {
            RecordBody::Fold(_)
                if run
                    .last()
                    .is_none_or(|known: &&TimelineRecord| known.day == record.day) =>
            {
                run.push(record);
            }
            RecordBody::Fold(_) => {
                if let Some(item) = fold_run(&run) {
                    items.push(item);
                }
                run = vec![record];
            }
            RecordBody::Chat(_) | RecordBody::Line(_) | RecordBody::Gap(_) => {
                if !run.is_empty() {
                    if let Some(item) = fold_run(&run) {
                        items.push(item);
                    }
                    run.clear();
                }
                items.push(record.clone().into());
            }
        }
    }
    if !run.is_empty()
        && let Some(item) = fold_run(&run)
    {
        items.push(item);
    }
    Ok(items)
}

fn fold_run(records: &[&TimelineRecord]) -> Option<FoldedItem> {
    let first_record = records.first().expect("runs are non-empty");
    let run = collapse_run(records.iter().map(|record| {
        let RecordBody::Fold(event) = &record.body else {
            unreachable!("run records are fold events");
        };
        (record.order, event)
    }))?;
    Some(FoldedItem {
        id: records
            .iter()
            .map(|record| record.id)
            .min_by_key(|id| id.0)
            .expect("runs are non-empty"),
        order: first_record.order,
        day: first_record.day,
        body: FoldedBody::Run(run),
        record_ids: records.iter().map(|record| record.id).collect(),
    })
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
            RecordBody::Fold(_) => unreachable!("fold records are built as runs"),
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
    use crate::{MessageAuthorship, MessageDelivery, MessageId, MessageKind, MessageProjection};

    use super::{ChatRecord, FoldEvent, FoldedBody, RecordBody, TimelineRecord, Who, fold};
    use crate::timeline::{GapProjection, LineEvent, LocalDay, OrderKey, TimelineError};

    fn joined(id: u64, primary_ms: i64) -> TimelineRecord {
        TimelineRecord {
            id: MessageId(id),
            order: OrderKey::new(primary_ms, primary_ms + 10, id),
            day: LocalDay(1),
            body: RecordBody::Fold(FoldEvent::Joined(Who {
                nick: format!("nick-{id}"),
                key: format!("nick-{id}"),
                nick_color_index: 0,
                own: false,
                msgid: Some(format!("msg-{id}")),
            })),
        }
    }

    fn chat(id: u64, primary_ms: i64) -> TimelineRecord {
        TimelineRecord {
            id: MessageId(id),
            order: OrderKey::new(primary_ms, primary_ms + 10, id),
            day: LocalDay(1),
            body: RecordBody::Chat(ChatRecord {
                projection: MessageProjection {
                    id: MessageId(id),
                    author: "mel".into(),
                    text: "break".into(),
                    kind: MessageKind::Text,
                    bot: None,
                    authorship: MessageAuthorship::Other,
                    nick_color_index: 0,
                    highlighted: false,
                    unverified_sender: None,
                    reactions: None,
                    delivery: MessageDelivery::Received,
                    local_send_id: None,
                    server_ids: Vec::new(),
                    server_time_ms: Some(primary_ms),
                    received_at_ms: primary_ms + 10,
                },
            }),
        }
    }

    fn line(id: u64, primary_ms: i64) -> TimelineRecord {
        TimelineRecord {
            id: MessageId(id),
            order: OrderKey::new(primary_ms, primary_ms + 10, id),
            day: LocalDay(1),
            body: RecordBody::Line(LineEvent::Raw {
                line: "break".into(),
            }),
        }
    }

    fn gap(id: u64, primary_ms: i64) -> TimelineRecord {
        TimelineRecord {
            id: MessageId(id),
            order: OrderKey::new(primary_ms, primary_ms + 10, id),
            day: LocalDay(1),
            body: RecordBody::Gap(GapProjection {
                from_ms: primary_ms,
                to_ms: primary_ms + 1,
            }),
        }
    }

    #[test]
    fn adjacent_memberships_share_one_run_with_the_smallest_id() {
        let records = [joined(4, 10), joined(7, 20)];
        let items = fold(&records).expect("valid records");

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, MessageId(4));
        assert_eq!(items[0].record_ids(), [MessageId(4), MessageId(7)]);
        assert!(matches!(items[0].body, FoldedBody::Run(ref run) if
            matches!(run.clauses().as_slice(), [crate::timeline::RunClause::Joined { people }]
                if people.len() == 2) && run.newest_time_ms() == 20));
    }

    #[test]
    fn chat_line_gap_and_day_changes_break_runs() {
        let records = [
            joined(1, 10),
            joined(2, 20),
            chat(3, 30),
            joined(4, 40),
            line(5, 50),
            joined(6, 60),
            gap(7, 70),
            joined(8, 80),
        ];
        let items = fold(&records).expect("valid records");
        assert_eq!(items.len(), 7);
        assert!(matches!(items[0].body, FoldedBody::Run(_)));
        assert!(matches!(items[1].body, FoldedBody::Chat(_)));
        assert!(matches!(items[3].body, FoldedBody::Line(_)));
        assert!(matches!(items[5].body, FoldedBody::Gap(_)));

        let mut next_day = joined(10, 100);
        next_day.day = LocalDay(2);
        assert_eq!(fold(&[joined(9, 90), next_day]).expect("days").len(), 2);
    }

    #[test]
    fn older_growth_split_and_merge_keep_the_smallest_run_id() {
        let joined_first = joined(1, 10);
        let joined_second = joined(2, 20);
        let merged = fold(&[joined_first.clone(), joined_second.clone()]).expect("merged");
        assert_eq!(merged[0].id, MessageId(1));

        let split = fold(&[joined_first.clone(), chat(3, 15), joined_second.clone()])
            .expect("split by chat");
        assert_eq!(split[0].id, MessageId(1));
        assert_eq!(split[2].id, MessageId(2));

        let moved = fold(&[joined_first, joined_second, chat(3, 30)]).expect("breaker moved");
        assert_eq!(moved[0].id, MessageId(1));
        assert_eq!(moved.len(), 2);

        let older = fold(&[joined(4, 5), joined(1, 10), joined(2, 20)]).expect("older growth");
        assert_eq!(older[0].id, MessageId(1));
        assert_eq!(older[0].order.primary_ms(), 5);
    }

    #[test]
    fn equal_time_members_use_msgid_order() {
        let mut first = joined(1, 10);
        let RecordBody::Fold(FoldEvent::Joined(first_who)) = &mut first.body else {
            unreachable!("join fixture");
        };
        first_who.msgid = Some("z".into());
        let mut second = joined(2, 10);
        second.order = OrderKey::new(10, 30, 2);
        let RecordBody::Fold(FoldEvent::Joined(second_who)) = &mut second.body else {
            unreachable!("join fixture");
        };
        second_who.msgid = Some("a".into());

        let items = fold(&[first, second]).expect("same-time run");
        assert!(matches!(&items[0].body, FoldedBody::Run(run)
            if matches!(run.clauses().as_slice(), [crate::timeline::RunClause::Joined { people }]
                if people.iter().map(|person| person.nick.as_str()).eq(["nick-2", "nick-1"]))));
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
