use std::collections::{HashMap, HashSet};

use crate::PeerPresence;
use crate::state::event_millis;

/// When this connection saw a DM peer go away or offline. A time is kept only for a change seen
/// happening: a `731` answering our first `MONITOR +` says the peer was already gone, not when.
#[derive(Debug, Default)]
pub(crate) struct WitnessedPresence {
    seen_online: HashSet<papo::Nick>,
    changes: HashMap<papo::Nick, Change>,
}

#[derive(Clone, Copy, Debug)]
struct Change {
    presence: PeerPresence,
    at_ms: i64,
}

impl WitnessedPresence {
    pub(crate) fn observe(&mut self, event: &papo::Event, now_ms: i64) {
        match event {
            papo::Event::MonitorOnline(online) => {
                let nick = online.subject.nick();
                self.changes.remove(&nick);
                self.seen_online.insert(nick);
            }
            papo::Event::MonitorOffline(offline) => {
                let nick = &offline.subject.nick();
                if self.seen_online.remove(nick) {
                    self.record(nick, PeerPresence::Offline, now_ms);
                } else if self.since(nick, PeerPresence::Offline).is_none() {
                    self.changes.remove(nick);
                }
            }
            papo::Event::AwayChanged(changed) => {
                let nick = &changed.actor.nick();
                if matches!(changed.away, papo::AwayStatus::Away { .. }) {
                    let at = event_millis(changed.server_time, changed.received_at);
                    self.record(nick, PeerPresence::Away, at);
                } else {
                    self.changes.remove(nick);
                }
            }
            papo::Event::Quit(quit) => {
                let at = event_millis(quit.server_time, quit.received_at);
                self.record(&quit.actor.nick(), PeerPresence::Offline, at);
            }
            papo::Event::NickChanged(changed) => {
                let old = &changed.old;
                if self.seen_online.remove(old) {
                    self.seen_online.insert(changed.new.clone());
                }
                if let Some(change) = self.changes.remove(old) {
                    self.changes.insert(changed.new.clone(), change);
                }
            }
            papo::Event::Connected(_) | papo::Event::Disconnected(_) => {
                self.seen_online.clear();
                self.changes.clear();
            }
            _ => {}
        }
    }

    /// When the peer was seen entering `presence`, if it was and that is still its state.
    pub(crate) fn since(&self, nick: &papo::Nick, presence: PeerPresence) -> Option<i64> {
        self.changes
            .get(nick)
            .filter(|change| change.presence == presence)
            .map(|change| change.at_ms)
    }

    fn record(&mut self, nick: &papo::Nick, presence: PeerPresence, at_ms: i64) {
        self.changes
            .insert(nick.clone(), Change { presence, at_ms });
    }
}
