//! Pure timeline ordering, folding, and patch reduction.

mod projection;

pub use projection::{
    Actor, Departure, GapProjection, ItemBody, LineEvent, LocalDay, MemberRank, ModeMeaning,
    ModeProjection, NickChange, OrderKey, Person, ReplySeverity, RunClause, Subject, SystemLine,
    SystemProjection, TimelineItem,
};
