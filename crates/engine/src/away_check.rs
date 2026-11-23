use std::collections::{HashSet, VecDeque};

/// A `MONITOR` online reply carries no away state, and a server with extended-monitor reports only
/// later changes, so a watched peer who comes online gets exactly one `WHO` (Luiz, F53). papo
/// records its answer as the peer's away state, which `away-notify` keeps current after that.
#[derive(Debug, Default)]
pub(crate) struct AwayChecks {
    asked: HashSet<papo::Nick>,
    queue: VecDeque<papo::Nick>,
    working: bool,
}

impl AwayChecks {
    pub(crate) fn observe(&mut self, event: &papo::Event) {
        match event {
            papo::Event::MonitorOnline(online) => {
                let nick = online.subject.nick();
                if self.asked.insert(nick.clone()) {
                    self.queue.push_back(nick);
                }
            }
            papo::Event::MonitorOffline(offline) => self.forget(&offline.subject.nick()),
            papo::Event::Quit(quit) => self.forget(&quit.actor.nick()),
            papo::Event::NickChanged(changed) => self.rename(&changed.old, &changed.new),
            papo::Event::Connected(_) | papo::Event::Disconnected(_) => {
                self.asked.clear();
                self.queue.clear();
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

    /// The next queued peer whose away state only a `WHO nick` can give. A peer papo learned
    /// about in the meantime is dropped, and so is one in a shared channel: that channel's own
    /// `WHO` reports it, and asking again would add a request to every launch's catch-up.
    pub(crate) fn next(&mut self, state: &papo::State) -> Option<papo::Nick> {
        while let Some(nick) = self.queue.pop_front() {
            if crate::name_key::known_user(state, &nick)
                .is_some_and(|user| user.channels().len() == 0 && !away_reported(user.away()))
            {
                return Some(nick);
            }
        }
        self.working = false;
        None
    }

    fn forget(&mut self, nick: &papo::Nick) {
        self.asked.remove(nick);
        self.queue.retain(|queued| queued != nick);
    }

    fn rename(&mut self, old: &papo::Nick, new: &papo::Nick) {
        if self.asked.remove(old) {
            self.asked.insert(new.clone());
        }

        for queued in &mut self.queue {
            if queued == old {
                new.clone_into(queued);
            }
        }
    }
}

const fn away_reported(away: &papo::AwayStatus) -> bool {
    matches!(
        away,
        papo::AwayStatus::Away { .. } | papo::AwayStatus::Present
    )
}
