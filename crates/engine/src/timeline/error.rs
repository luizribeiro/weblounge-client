use crate::MessageId;

/// A malformed timeline snapshot or patch.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum TimelineError {
    /// Two records or items claim the same stable identity.
    #[error("timeline identity {0:?} occurs more than once")]
    DuplicateId(MessageId),
    /// Engine-owned records are not in strict total order.
    #[error("timeline records are not strictly ordered")]
    UnsortedRecords,
    /// Projected items or patch upserts are not in strict total order.
    #[error("timeline items are not strictly ordered")]
    UnsortedItems,
    /// One patch tries to remove and upsert the same identity.
    #[error("timeline patch both removes and upserts {0:?}")]
    ConflictingPatchId(MessageId),
    /// A visible-content revision cannot advance further.
    #[error("timeline content version overflowed for {0:?}")]
    ContentVersionOverflow(MessageId),
}
