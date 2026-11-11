//! Pure timeline ordering, folding, and patch reduction.

mod calendar;
mod error;
mod fold;
mod patch;
mod projection;

#[cfg(test)]
mod fixture_tests;
#[cfg(test)]
mod property_tests;

pub use calendar::{FixedOffsetCalendar, LocalCalendar};
pub use error::TimelineError;
pub use fold::{
    ChatRecord, FoldEvent, FoldRun, FoldedBody, FoldedItem, RecordBody, SplitServers,
    TimelineRecord, Who, fold,
};
pub use patch::{
    AppliedTimeline, GeometryClass, TimelineChange, TimelineDiff, apply_timeline_change, diff,
};
pub use projection::{
    Actor, Departure, GapProjection, ItemBody, LineEvent, LocalDay, MemberRank, ModeMeaning,
    ModeProjection, NickChange, OrderKey, Person, ReplySeverity, RunClause, RunClauses, Subject,
    SystemLine, SystemProjection, TimelineItem,
};
