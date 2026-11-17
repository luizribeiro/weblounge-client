use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use super::{
    HISTORY_PAGE_SIZE, RunningNetwork, RuntimeState, history_page_bounds, lock,
    publish_history_turn, receive_history_items, spawn_task, start_read_flush,
};
use crate::{
    EngineToUi,
    state::{GapFetch, GapPage, HistoryLoad, NetworkModel},
};

/// One page right after a catch-up fills a short outage without waiting for the gap row to show.
pub(super) fn catch_up_gap_fill(
    model: &mut NetworkModel,
    load: Option<HistoryLoad>,
    conversation: &papo::Conversation,
) -> Option<GapFetch> {
    if !matches!(load, Some(HistoryLoad::Latest | HistoryLoad::Refresh)) {
        return None;
    }
    let buffer_id = model.buffer_id_for_conversation(conversation)?;
    model.begin_gap_fill(buffer_id)
}

pub(super) fn spawn_gap_fill(
    state: Arc<Mutex<RuntimeState>>,
    outbound: mpsc::UnboundedSender<EngineToUi>,
    client: papo::Client,
    instance: u64,
    fetch: GapFetch,
) {
    spawn_task(async move {
        let page = fetch_gap_page(&client, &fetch).await;
        let next = {
            let mut guard = lock(&state);
            let Some(running) = guard
                .network
                .as_mut()
                .filter(|running| running.instance == instance)
            else {
                return;
            };
            let (events, next) = if let Ok(page) = page {
                receive_gap_page(running, &client, &fetch, page)
            } else {
                running.model.fail_gap_fill(&fetch);
                (Vec::new(), None)
            };
            let read_flush = start_read_flush(running);
            publish_history_turn(guard, &state, &outbound, instance, events, read_flush);
            next
        };
        if let Some(next) = next {
            spawn_gap_fill(state, outbound, client, instance, next);
        }
    });
}

async fn fetch_gap_page(
    client: &papo::Client,
    fetch: &GapFetch,
) -> Result<papo::HistoryPage, papo::Error> {
    client
        .history(fetch.target.conversation())
        .before(fetch.before())
        .limit(HISTORY_PAGE_SIZE)
        .await
}

pub(super) fn receive_gap_page(
    running: &mut RunningNetwork,
    client: &papo::Client,
    fetch: &GapFetch,
    page: papo::HistoryPage,
) -> (Vec<EngineToUi>, Option<GapFetch>) {
    let filled = GapPage {
        oldest_time_ms: history_page_bounds(&page).oldest_time_ms,
        item_count: page.items.len(),
        end: page.end,
    };
    let mut events = receive_history_items(running, client, page.items);
    let (buffer_id, next) = running.model.finish_gap_fill(fetch, filled);
    events.extend(buffer_id.and_then(|buffer_id| running.model.buffer_updated(buffer_id)));
    (events, next)
}
