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
}
