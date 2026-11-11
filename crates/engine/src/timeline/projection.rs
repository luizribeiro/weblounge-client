#![allow(missing_docs)]

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use ts_rs::TS;

use crate::{EngineMessageKey, MessageId, MessageProjection, NoticeTone};

/// Total engine ordering for timeline records and projected items.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[ts(type = "[number, number, number]")]
pub struct OrderKey(pub i64, pub i64, pub u64);

impl OrderKey {
    /// Creates an order key from primary time, receipt time, and allocation sequence.
    #[must_use]
    pub const fn new(primary_ms: i64, received_ms: i64, sequence: u64) -> Self {
        Self(primary_ms, received_ms, sequence)
    }

    /// Returns the primary server-anchored time.
    #[must_use]
    pub const fn primary_ms(self) -> i64 {
        self.0
    }
}

/// A local-calendar day counted from 1970-01-01.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(transparent)]
#[ts(type = "number")]
pub struct LocalDay(pub i32);

/// One engine-ordered timeline item sent to the UI.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct TimelineItem {
    /// Stable identity in the shared timeline ID space.
    pub id: MessageId,
    /// Engine-owned total ordering; consumers compare but never compute it.
    pub order: OrderKey,
    /// Local-calendar day used for day dividers and fold boundaries.
    pub day: LocalDay,
    /// Monotonic revision of this identity's visible content.
    pub content_version: u32,
    /// Typed row content.
    pub body: ItemBody,
}

/// The three engine-owned timeline row families.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "family", rename_all = "snake_case")]
pub enum ItemBody {
    /// A chat row. Its nested legacy ID is removed when the old stream is retired.
    Message(MessageProjection),
    /// A collapsed or standalone system line.
    System(SystemProjection),
    /// A known missing interval.
    Gap(GapProjection),
}

/// Presentation of one system line.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct SystemProjection {
    /// Primary time of the newest member of this line.
    #[ts(type = "number")]
    pub time_ms: i64,
    /// Structured system-line content.
    pub line: SystemLine,
}

/// A collapsed run or one standalone event.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SystemLine {
    /// One or more non-empty run clauses.
    Run { clauses: RunClauses },
    /// An event that breaks membership runs.
    Event { event: LineEvent },
}

/// A non-empty sequence of semantic run clauses.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, TS)]
#[serde(transparent)]
#[ts(as = "Vec<RunClause>")]
pub struct RunClauses(Vec<RunClause>);

impl RunClauses {
    /// Creates a run from its required first clause and any following clauses.
    #[must_use]
    pub fn new(first: RunClause, rest: Vec<RunClause>) -> Self {
        Self(std::iter::once(first).chain(rest).collect())
    }

    /// Returns the clauses in display order.
    #[must_use]
    pub fn as_slice(&self) -> &[RunClause] {
        &self.0
    }
}

impl<'de> Deserialize<'de> for RunClauses {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let clauses = Vec::<RunClause>::deserialize(deserializer)?;
        if clauses.is_empty() {
            Err(D::Error::custom("a system run needs at least one clause"))
        } else {
            Ok(Self(clauses))
        }
    }
}

/// One semantic clause inside a collapsed run.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunClause {
    Joined {
        people: Vec<Person>,
    },
    JoinedAndLeft {
        people: Vec<Person>,
    },
    Left {
        people: Vec<Departure>,
    },
    Quit {
        people: Vec<Departure>,
    },
    Reconnected {
        people: Vec<Person>,
    },
    Rejoined {
        people: Vec<Person>,
    },
    Nick {
        changes: Vec<NickChange>,
    },
    Modes {
        actor: Actor,
        changes: Vec<ModeProjection>,
    },
    Invited {
        actor: Actor,
        people: Vec<Person>,
    },
}

/// A system event that always stands alone and breaks a run.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LineEvent {
    Kick {
        actor: Actor,
        subject: Subject,
        reason: Option<String>,
    },
    Topic {
        actor: Actor,
        topic: Option<String>,
    },
    TopicCard {
        topic: String,
        setter: Option<String>,
        #[ts(type = "number | null")]
        set_at_ms: Option<i64>,
    },
    InvitedYou {
        actor: Actor,
        channel: String,
    },
    Renamed {
        old: String,
        new: String,
        actor: Actor,
    },
    Connected {
        server: String,
        secure: bool,
    },
    Motd {
        lines: Vec<String>,
    },
    Reply {
        code: String,
        text: String,
        severity: ReplySeverity,
    },
    Raw {
        line: String,
    },
    Note {
        key: EngineMessageKey,
        values: BTreeMap<String, String>,
        tone: NoticeTone,
    },
}

/// A projected nick and its presentation facts.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct Person {
    pub nick: String,
    #[ts(type = "number")]
    pub nick_color_index: u32,
    pub me: bool,
}

/// A person leaving with an optional reason.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct Departure {
    pub person: Person,
    pub reason: Option<String>,
}

/// One collapsed nick transition.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct NickChange {
    pub old: Person,
    pub new: Person,
}

/// Actor responsible for a system event.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Actor {
    User(Person),
    Server { name: String },
}

/// Subject of a system event relative to the current user.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Subject {
    You,
    Other(Person),
}

/// A known incomplete time range.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct GapProjection {
    #[ts(type = "number")]
    pub from_ms: i64,
    #[ts(type = "number")]
    pub to_ms: i64,
}

/// One channel mode transition.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct ModeProjection {
    pub added: bool,
    pub meaning: ModeMeaning,
    pub raw: String,
    pub raw_group_start: bool,
}

/// A server-advertised member rank, kept dynamic for arbitrary PREFIX tokens.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct MemberRank {
    pub mode: char,
    pub symbol: char,
}

/// Semantic meaning of one mode transition.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ModeMeaning {
    Rank { rank: MemberRank, member: Person },
    Ban { mask: String },
    BanException { mask: String },
    InviteException { mask: String },
    Quiet { mask: String },
    Moderated,
    TopicLocked,
    NoExternal,
    InviteOnly,
    Secret,
    Private,
    Key,
    Limit { limit: Option<String> },
    Other,
}

/// Severity supplied by a standard reply.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ReplySeverity {
    Fail,
    Warn,
    Note,
}

#[cfg(test)]
mod tests {
    use super::{LocalDay, OrderKey, RunClause, RunClauses, SystemLine};

    #[test]
    fn order_and_day_use_the_wire_shapes_from_the_design() {
        assert_eq!(
            serde_json::to_value(OrderKey::new(10, 20, 30)).expect("serializable order key"),
            serde_json::json!([10, 20, 30]),
        );
        assert_eq!(
            serde_json::to_value(LocalDay(42)).expect("serializable local day"),
            serde_json::json!(42),
        );
    }

    #[test]
    fn system_runs_are_non_empty_on_construction_and_deserialization() {
        let clauses = RunClauses::new(RunClause::Joined { people: Vec::new() }, Vec::new());
        assert_eq!(clauses.as_slice().len(), 1);
        assert!(serde_json::from_str::<SystemLine>(r#"{"type":"run","clauses":[]}"#).is_err());
    }
}
