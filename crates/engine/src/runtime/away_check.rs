use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use super::{RunningNetwork, RuntimeState, lock, send_events, spawn_task};
use crate::EngineToUi;

/// Starts the away-check worker when peers are queued and none is running. One `WHO` is in flight
/// at a time, so a reconnect that brings many watched peers online doesn't burst the server.
pub(super) fn start_away_checks(
    running: &mut RunningNetwork,
    state: &Arc<Mutex<RuntimeState>>,
    outbound: &mpsc::UnboundedSender<EngineToUi>,
) {
    if !running.model.away_checks().claim_worker() {
        return;
    }
    let (state, outbound) = (Arc::clone(state), outbound.clone());
    let (client, instance) = (running.client.clone(), running.instance);
    spawn_task(async move {
        while let Some(nick) = next_check(&state, instance) {
            let reply = client.who(nick.as_str()).await;
            let mut guard = lock(&state);
            let Some(running) = guard
                .network
                .as_mut()
                .filter(|running| running.instance == instance)
            else {
                return;
            };
            if let Some(entry) = reply
                .iter()
                .flatten()
                .find(|entry| entry.user.nick() == nick)
            {
                running.model.away_checks().answer(&nick, &entry.away);
            }
            let events = running.model.sync_direct_peers(&running.client.snapshot());
            drop(guard);
            send_events(&outbound, events);
        }
    });
}

fn next_check(state: &Arc<Mutex<RuntimeState>>, instance: u64) -> Option<papo::Nick> {
    let mut guard = lock(state);
    let running = guard
        .network
        .as_mut()
        .filter(|running| running.instance == instance)?;
    let snapshot = running.client.snapshot();
    running.model.away_checks().next(&snapshot)
}
