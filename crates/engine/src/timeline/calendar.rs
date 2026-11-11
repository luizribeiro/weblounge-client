use super::LocalDay;

/// Converts Unix timestamps into the device's local-calendar day.
pub trait LocalCalendar: Send + Sync {
    /// Returns the local day containing `unix_ms`.
    fn day(&self, unix_ms: i64) -> LocalDay;
}

/// Calendar with a stable UTC offset, used by native defaults and tests.
#[derive(Clone, Copy, Debug, Default)]
pub struct FixedOffsetCalendar {
    offset_minutes: i32,
}

impl FixedOffsetCalendar {
    /// Creates a calendar whose local time is `offset_minutes` east of UTC.
    #[must_use]
    pub const fn new(offset_minutes: i32) -> Self {
        Self { offset_minutes }
    }
}

impl LocalCalendar for FixedOffsetCalendar {
    fn day(&self, unix_ms: i64) -> LocalDay {
        const MINUTE_MS: i64 = 60_000;
        const DAY_MS: i64 = 86_400_000;
        let local_ms = unix_ms.saturating_add(i64::from(self.offset_minutes) * MINUTE_MS);
        let day = local_ms.div_euclid(DAY_MS);
        LocalDay(i32::try_from(day).unwrap_or(if day < 0 { i32::MIN } else { i32::MAX }))
    }
}

#[cfg(test)]
mod tests {
    use super::{FixedOffsetCalendar, LocalCalendar};
    use crate::timeline::LocalDay;

    #[test]
    fn fixed_offset_uses_local_midnight() {
        let calendar = FixedOffsetCalendar::new(-5 * 60);

        assert_eq!(calendar.day(5 * 60 * 60 * 1_000 - 1), LocalDay(-1));
        assert_eq!(calendar.day(5 * 60 * 60 * 1_000), LocalDay(0));
    }
}
