use std::{collections::HashMap, time::Duration};

use crate::BufferId;

pub(crate) const PAUSE_AFTER: Duration = Duration::from_secs(3);

#[cfg(test)]
trait Clock {
    fn now(&self) -> Duration;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Pause {
    pub(crate) buffer_id: BufferId,
    pub(crate) generation: u64,
}

#[derive(Default)]
pub(crate) struct OutgoingTyping {
    sessions: HashMap<BufferId, Session>,
    next_generation: u64,
}

struct Session {
    generation: u64,
    #[cfg(test)]
    pause_at: Duration,
    paused: bool,
}

impl OutgoingTyping {
    pub(crate) fn changed(
        &mut self,
        buffer_id: BufferId,
        input: &str,
    ) -> (Option<papo::Typing>, Option<Pause>) {
        self.changed_inner(buffer_id, input, Duration::ZERO)
    }

    #[cfg(test)]
    fn changed_at(
        &mut self,
        buffer_id: BufferId,
        input: &str,
        clock: &impl Clock,
    ) -> (Option<papo::Typing>, Option<Pause>) {
        self.changed_inner(buffer_id, input, clock.now().saturating_add(PAUSE_AFTER))
    }

    fn changed_inner(
        &mut self,
        buffer_id: BufferId,
        input: &str,
        pause_at: Duration,
    ) -> (Option<papo::Typing>, Option<Pause>) {
        #[cfg(not(test))]
        let _ = pause_at;
        if input.is_empty() || is_slash_command(input) {
            return (self.done(buffer_id), None);
        }
        self.next_generation = self.next_generation.wrapping_add(1);
        let generation = self.next_generation;
        self.sessions.insert(
            buffer_id,
            Session {
                generation,
                #[cfg(test)]
                pause_at,
                paused: false,
            },
        );
        (
            Some(papo::Typing::Active),
            Some(Pause {
                buffer_id,
                generation,
            }),
        )
    }

    #[cfg(test)]
    fn expire(&mut self, pause: Pause, clock: &impl Clock) -> Option<papo::Typing> {
        if clock.now() < self.sessions.get(&pause.buffer_id)?.pause_at {
            return None;
        }
        self.expire_scheduled(pause)
    }

    pub(crate) fn expire_scheduled(&mut self, pause: Pause) -> Option<papo::Typing> {
        let session = self.sessions.get_mut(&pause.buffer_id)?;
        if session.generation != pause.generation || session.paused {
            return None;
        }
        session.paused = true;
        Some(papo::Typing::Paused)
    }

    pub(crate) fn done(&mut self, buffer_id: BufferId) -> Option<papo::Typing> {
        self.sessions.remove(&buffer_id).map(|_| papo::Typing::Done)
    }
}

fn is_slash_command(input: &str) -> bool {
    input.starts_with('/') && !input.starts_with("//")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeClock(Duration);

    impl Clock for FakeClock {
        fn now(&self) -> Duration {
            self.0
        }
    }

    #[test]
    fn transitions_active_to_paused_and_done_with_a_fake_clock() {
        let mut typing = OutgoingTyping::default();
        let mut clock = FakeClock::default();
        let (state, pause) = typing.changed_at(BufferId(4), "hello", &clock);
        assert_eq!(state, Some(papo::Typing::Active));

        clock.0 = PAUSE_AFTER
            .checked_sub(Duration::from_millis(1))
            .expect("pause delay exceeds one millisecond");
        assert_eq!(typing.expire(pause.expect("pause scheduled"), &clock), None);
        clock.0 = PAUSE_AFTER;
        assert_eq!(
            typing.expire(pause.expect("pause scheduled"), &clock),
            Some(papo::Typing::Paused)
        );
        assert_eq!(typing.done(BufferId(4)), Some(papo::Typing::Done));
        assert_eq!(typing.done(BufferId(4)), None);
    }

    #[test]
    fn refreshes_and_buffers_have_independent_deadlines() {
        let mut typing = OutgoingTyping::default();
        let mut clock = FakeClock::default();
        let (_, stale) = typing.changed_at(BufferId(1), "a", &clock);
        clock.0 = Duration::from_secs(2);
        let (_, current) = typing.changed_at(BufferId(1), "ab", &clock);
        let (_, other) = typing.changed_at(BufferId(2), "x", &clock);
        clock.0 = Duration::from_secs(3);
        assert_eq!(typing.expire(stale.expect("pause scheduled"), &clock), None);
        clock.0 = Duration::from_secs(5);
        assert_eq!(
            typing.expire(current.expect("pause scheduled"), &clock),
            Some(papo::Typing::Paused)
        );
        assert_eq!(
            typing.expire(other.expect("pause scheduled"), &clock),
            Some(papo::Typing::Paused)
        );
    }

    #[test]
    fn empty_and_command_input_finish_without_starting_commands() {
        let mut typing = OutgoingTyping::default();
        let clock = FakeClock::default();
        assert_eq!(typing.changed_at(BufferId(1), "", &clock), (None, None));
        assert_eq!(
            typing.changed_at(BufferId(1), "/join #room", &clock),
            (None, None)
        );
        assert_eq!(
            typing.changed_at(BufferId(1), "//literal", &clock).0,
            Some(papo::Typing::Active)
        );
        assert_eq!(
            typing.changed_at(BufferId(1), "/me waves", &clock).0,
            Some(papo::Typing::Done)
        );
    }
}
