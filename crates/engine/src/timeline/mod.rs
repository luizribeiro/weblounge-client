//! Pure timeline ordering, folding, and patch reduction.

mod error;
mod fold;
mod projection;

pub use error::TimelineError;
pub use fold::{
    ChatRecord, FoldEvent, FoldRun, FoldedBody, FoldedItem, RecordBody, SplitServers,
    TimelineRecord, Who, fold,
};
pub use projection::{
    Actor, Departure, GapProjection, ItemBody, LineEvent, LocalDay, MemberRank, ModeMeaning,
    ModeProjection, NickChange, OrderKey, Person, ReplySeverity, RunClause, Subject, SystemLine,
    SystemProjection, TimelineItem,
};
