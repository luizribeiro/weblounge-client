//! Product outcomes for bounded papo request state.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StateLimitOutcome {
    SharedNotice(&'static str),
    ChannelNotice(&'static str),
    Log,
}

// The explicit read-marker arm protects its product policy while papo's non-exhaustive enum still
// requires a log-only fallback for limits introduced by a future pinned revision.
#[allow(clippy::match_same_arms)]
pub(crate) fn state_limit_outcome(
    limit: papo::StateLimit,
    user_initiated: bool,
) -> StateLimitOutcome {
    match limit {
        papo::StateLimit::Channels => {
            StateLimitOutcome::SharedNotice("engine.channel_limit_reached")
        }
        papo::StateLimit::ReadMarkers => StateLimitOutcome::Log,
        papo::StateLimit::ListEntries => StateLimitOutcome::ChannelNotice(
            "No entry was added because this channel's list is full.",
        ),
        papo::StateLimit::MetadataTargets | papo::StateLimit::MetadataKeys if user_initiated => {
            StateLimitOutcome::SharedNotice("engine.metadata_limit_reached")
        }
        papo::StateLimit::BouncerNetworks if user_initiated => {
            StateLimitOutcome::SharedNotice("engine.bouncer_network_limit_reached")
        }
        _ => StateLimitOutcome::Log,
    }
}

#[cfg(test)]
mod tests {
    use super::{StateLimitOutcome, state_limit_outcome};

    #[test]
    fn channels_use_the_shared_human_notice() {
        assert_eq!(
            state_limit_outcome(papo::StateLimit::Channels, true),
            StateLimitOutcome::SharedNotice("engine.channel_limit_reached")
        );
    }

    #[test]
    fn read_markers_are_log_only() {
        assert_eq!(
            state_limit_outcome(papo::StateLimit::ReadMarkers, true),
            StateLimitOutcome::Log
        );
    }

    #[test]
    fn list_additions_use_a_channel_notice() {
        assert!(matches!(
            state_limit_outcome(papo::StateLimit::ListEntries, true),
            StateLimitOutcome::ChannelNotice(_)
        ));
    }

    #[test]
    fn metadata_is_logged_until_a_person_initiates_it() {
        for limit in [
            papo::StateLimit::MetadataTargets,
            papo::StateLimit::MetadataKeys,
        ] {
            assert_eq!(state_limit_outcome(limit, false), StateLimitOutcome::Log);
            assert_eq!(
                state_limit_outcome(limit, true),
                StateLimitOutcome::SharedNotice("engine.metadata_limit_reached")
            );
        }
    }

    #[test]
    fn bouncer_adds_are_logged_until_a_person_initiates_them() {
        assert_eq!(
            state_limit_outcome(papo::StateLimit::BouncerNetworks, false),
            StateLimitOutcome::Log
        );
        assert_eq!(
            state_limit_outcome(papo::StateLimit::BouncerNetworks, true),
            StateLimitOutcome::SharedNotice("engine.bouncer_network_limit_reached")
        );
    }
}
