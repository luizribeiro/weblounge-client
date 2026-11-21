use std::collections::{HashMap, HashSet, VecDeque};

use crate::PeerPresence;

/// A `MONITOR` online reply carries no away state, and a server with extended-monitor reports only
/// later changes, so a watched peer who comes online gets exactly one `WHO` (Luiz, F53). Its
/// answer stands until the peer goes offline; `away-notify` keeps it current after that.
#[derive(Debug, Default)]
pub(crate) struct AwayChecks {
    asked: HashSet<papo::Nick>,
    queue: VecDeque<papo::Nick>,
    answers: HashMap<papo::Nick, PeerPresence>,
    working: bool,
}

impl AwayChecks {
    pub(crate) fn observe(&mut self, event: &papo::Event) {
        match event {
            papo::Event::MonitorOnline(online) => {
                let nick = online.subject.nick();
                if self.asked.insert(nick.clone()) {
                    self.queue.push_back(nick.clone());
                }
            }
            papo::Event::MonitorOffline(offline) => self.forget(&offline.subject),
            papo::Event::Quit(quit) => self.forget(quit.actor.nick()),
            papo::Event::NickChanged(changed) => self.rename(changed.actor.nick(), &changed.new),
            papo::Event::Connected(_) | papo::Event::Disconnected(_) => {
                self.asked.clear();
                self.queue.clear();
                self.answers.clear();
            }
            _ => {}
        }
    }

    /// Whether the caller should start the worker: peers are queued and none is running.
    pub(crate) fn claim_worker(&mut self) -> bool {
        let start = !self.working && !self.queue.is_empty();
        self.working |= start;
        start
    }

    /// The next queued peer whose away state is still unreported; a peer papo learned about in
    /// the meantime is dropped without a `WHO`.
    pub(crate) fn next(&mut self, state: &papo::State) -> Option<papo::Nick> {
        while let Some(nick) = self.queue.pop_front() {
            if state
                .user(&nick)
                .is_some_and(|user| !away_reported(user.away()))
            {
                return Some(nick);
            }
        }
        self.working = false;
        None
    }

    pub(crate) fn answer(&mut self, nick: &papo::Nick, away: &papo::Away) {
        if !self.asked.contains(nick) {
            return;
        }
        match away {
            papo::Away::Away { .. } => {
                self.answers.insert(nick.clone(), PeerPresence::Away);
            }
            papo::Away::Present => {
                self.answers.insert(nick.clone(), PeerPresence::Online);
            }
            _ => {}
        }
    }

    pub(crate) fn answered(&self, nick: &papo::Nick) -> Option<PeerPresence> {
        self.answers.get(nick).copied()
    }

    fn forget(&mut self, nick: &papo::Nick) {
        self.asked.remove(nick);
        self.answers.remove(nick);
        self.queue.retain(|queued| queued != nick);
    }

    fn rename(&mut self, old: &papo::Nick, new: &papo::Nick) {
        if self.asked.remove(old) {
            self.asked.insert(new.clone());
        }
        if let Some(answer) = self.answers.remove(old) {
            self.answers.insert(new.clone(), answer);
        }
        for queued in &mut self.queue {
            if queued == old {
                new.clone_into(queued);
            }
        }
    }
}

const fn away_reported(away: &papo::Away) -> bool {
    matches!(away, papo::Away::Away { .. } | papo::Away::Present)
}
