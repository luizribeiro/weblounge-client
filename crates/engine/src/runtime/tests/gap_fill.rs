use std::{sync::Arc, time::Duration};

use super::{
    EngineRequest, EngineRequestEnvelope, EngineToUi, HISTORY_CAPS, ReplayHarness, Runtime,
    collect, drain_events, harness, known_channel, lock, next_sent_containing,
    register_for_history, request_label, send_ergo_history_page, send_recent_targets,
    timeline_texts, wire, wire_time,
};
use crate::{BufferId, HistoryDirection, name_key::NameKey, timeline::ItemBody};

const GAP_FROM_MS: i64 = 1_793_102_400_000;
const GAP_TO_MS: i64 = GAP_FROM_MS + 5_000;
const FILL_REQUEST: &str = "CHATHISTORY BEFORE #room timestamp=2026-10-27T12:00:05.010Z 100";

/// Records the gap once the join has asked for its catch-up page, which the caller answers.
async fn joined_with_gap() -> (ReplayHarness, BufferId, String) {
    let mut harness = ReplayHarness::joined(HISTORY_CAPS).await;
    let latest = next_sent_containing(&mut harness.wire, "CHATHISTORY LATEST #room").await;
    let buffer_id = {
        let room = room(&harness);
        let mut state = lock(&harness.state);
        let model = &mut state.network.as_mut().expect("network").model;
        let buffer_id = model.buffer_id_for_name(&room).expect("joined room");
        model
            .record_gap(buffer_id, GAP_FROM_MS, GAP_TO_MS)
            .expect("gap");
        buffer_id
    };
    (harness, buffer_id, latest)
}

async fn finish_catch_up(harness: &mut ReplayHarness, latest: &str) -> String {
    send_ergo_history_page(
        &mut harness.wire,
        latest,
        &["@batch={batch};time=2026-10-27T12:00:05.000Z;msgid=after :alice!a@host PRIVMSG #room :after the gap"],
    )
    .await;
    let fill = next_sent_containing(&mut harness.wire, " CHATHISTORY BEFORE ").await;
    _ = collect(&mut harness.receiver);
    fill
}

fn removes_every_gap(events: &[EngineToUi], buffer_id: BufferId) -> bool {
    events.iter().any(|event| {
        matches!(
            event,
            EngineToUi::TimelineChanged { buffer_id: changed, removed, .. }
                if *changed == buffer_id && !removed.is_empty()
        )
    }) && !events.iter().any(|event| match event {
        EngineToUi::TimelineChanged { upserted, .. } => upserted
            .iter()
            .any(|item| matches!(item.body, ItemBody::Gap(_))),
        _ => false,
    })
}

async fn events_until(
    harness: &mut ReplayHarness,
    done: impl Fn(&[EngineToUi]) -> bool,
) -> Vec<EngineToUi> {
    let mut events = Vec::new();
    tokio::time::timeout(Duration::from_secs(1), async {
        while !done(&events) {
            events.push(
                harness
                    .receiver
                    .recv()
                    .await
                    .expect("runtime remains active"),
            );
        }
    })
    .await
    .expect("the expected events arrive");
    events
}

#[tokio::test]
async fn a_catch_up_fetches_the_page_before_a_recorded_gap_and_clears_it() {
    let (mut harness, buffer_id, latest) = joined_with_gap().await;

    let fill = finish_catch_up(&mut harness, &latest).await;
    assert!(fill.ends_with(FILL_REQUEST), "{fill}");
    send_ergo_history_page(
        &mut harness.wire,
        &fill,
        &[
            "@batch={batch};time=2026-10-27T11:59:59.000Z;msgid=before :alice!a@host PRIVMSG #room :before the gap",
            "@batch={batch};time=2026-10-27T12:00:02.000Z;msgid=inside :alice!a@host PRIVMSG #room :inside the gap",
            "@batch={batch};time=2026-10-27T12:00:05.000Z;msgid=after :alice!a@host PRIVMSG #room :after the gap",
        ],
    )
    .await;

    events_until(&mut harness, |events| {
        timeline_texts(events)
            .iter()
            .any(|text| text == "inside the gap")
            && removes_every_gap(events, buffer_id)
    })
    .await;
    let state = lock(&harness.state);
    let model = &state.network.as_ref().expect("network").model;
    let texts = model
        .projected_messages(buffer_id)
        .into_iter()
        .map(|message| message.text)
        .collect::<Vec<_>>();
    assert_eq!(
        texts,
        ["before the gap", "inside the gap", "after the gap"],
        "every line once, in order"
    );
}

/// Ergo's answer to a `BEFORE timestamp=…` page: the stored lines stamped before the bound.
fn stamped_before(request: &str, stored: &[(&str, &str)]) -> Vec<String> {
    let bound = request
        .split(' ')
        .find_map(|word| word.strip_prefix("timestamp="))
        .expect("a timestamp bound");
    stored
        .iter()
        .filter(|(time, _)| *time < bound)
        .map(|(time, id)| {
            format!("@batch={{batch}};time={time};msgid={id} :alice!a@host PRIVMSG #room :{id}")
        })
        .collect()
}

/// The CI loss behind B38: `stored-early` is stamped 3ms past the catch-up page's oldest line,
/// but Ergo stored it before that line, so the capped catch-up page left it out.
#[tokio::test]
async fn a_fill_brings_a_line_stamped_past_the_edge_but_stored_before_it() {
    let (mut harness, buffer_id, latest) = joined_with_gap().await;
    let fill = finish_catch_up(&mut harness, &latest).await;

    let page = stamped_before(
        &fill,
        &[
            ("2026-10-27T11:59:59.000Z", "before"),
            ("2026-10-27T12:00:02.000Z", "inside"),
            ("2026-10-27T12:00:05.003Z", "stored-early"),
            ("2026-10-27T12:00:05.000Z", "after"),
        ],
    );
    let page: Vec<&str> = page.iter().map(String::as_str).collect();
    send_ergo_history_page(&mut harness.wire, &fill, &page).await;

    events_until(&mut harness, |events| removes_every_gap(events, buffer_id)).await;
    let state = lock(&harness.state);
    let model = &state.network.as_ref().expect("network").model;
    let ids = model
        .projected_messages(buffer_id)
        .into_iter()
        .flat_map(|message| message.server_ids)
        .collect::<Vec<_>>();
    assert_eq!(ids, ["before", "inside", "after", "stored-early"]);
}

#[tokio::test]
async fn a_failed_fill_keeps_the_gap_until_the_next_catch_up_retries_it() {
    let (mut harness, buffer_id, latest) = joined_with_gap().await;

    let fill = finish_catch_up(&mut harness, &latest).await;
    harness
        .wire
        .server(format!(
            "@label={} :offline.test FAIL CHATHISTORY MESSAGE_ERROR #room :history unavailable",
            request_label(&fill)
        ))
        .await;
    tokio::time::timeout(Duration::from_secs(1), async {
        while gap_fill_loading(&harness, buffer_id) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the failed fill settles");

    let mut state = lock(&harness.state);
    let model = &mut state.network.as_mut().expect("network").model;
    let retry = model
        .begin_gap_fill(buffer_id)
        .expect("the gap stays for the next catch-up");
    assert_eq!(
        (retry.span.from_ms, retry.span.to_ms),
        (GAP_FROM_MS, GAP_TO_MS)
    );
}

fn gap_fill_loading(harness: &ReplayHarness, buffer_id: BufferId) -> bool {
    lock(&harness.state)
        .network
        .as_ref()
        .expect("network")
        .model
        .gap_fill_loading(buffer_id)
}

fn room(harness: &ReplayHarness) -> NameKey {
    NameKey::Channel(known_channel(&harness.client, "#room"))
}

#[tokio::test]
async fn a_shown_gap_row_fetches_the_next_page_into_what_is_still_missing() {
    let (mut harness, buffer_id, latest) = joined_with_gap().await;
    let fill = finish_catch_up(&mut harness, &latest).await;
    send_ergo_history_page(
        &mut harness.wire,
        &fill,
        &["@batch={batch};time=2026-10-27T12:00:03.000Z;msgid=late :alice!a@host PRIVMSG #room :late in the gap"],
    )
    .await;
    events_until(&mut harness, |events| {
        timeline_texts(events)
            .iter()
            .any(|text| text == "late in the gap")
    })
    .await;

    let result = Runtime {
        state: Arc::clone(&harness.state),
        outbound: harness.outbound.clone(),
    }
    .request(EngineRequestEnvelope {
        id: "gap".into(),
        request: EngineRequest::LoadHistory {
            buffer_id,
            direction: HistoryDirection::Gap,
        },
    });

    assert!(matches!(
        result.as_slice(),
        [EngineToUi::CommandResult { id }] if id == "gap"
    ));
    let next = next_sent_containing(&mut harness.wire, " CHATHISTORY BEFORE ").await;
    assert!(
        next.ends_with("CHATHISTORY BEFORE #room timestamp=2026-10-27T12:00:03.010Z 100"),
        "{next}"
    );
}

async fn reconnect_for_history(client: &papo::Client, wire: &mut papo_testing::Wire) {
    wire.close().await;
    while client.snapshot().is_connected() {
        tokio::task::yield_now().await;
    }
    client.reconnect().await.expect("manual reconnect starts");
    register_for_history(wire).await;
}

/// A reconnect whose catch-up page the connection cut off after `first_item`, which reaches the
/// engine as a replay page; the next connection has just asked for its targets.
struct CutOffCatchUp {
    wire: papo_testing::Wire,
    drain: tokio::task::JoinHandle<()>,
    cursor_before_cut: std::time::SystemTime,
    outage_time: String,
    targets: String,
}

impl CutOffCatchUp {
    async fn new(first_item: impl FnOnce(&str, &str) -> String) -> Self {
        let (client, events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge").autojoin(["#room"]));
        let (state, outbound, _receiver) = harness(client.clone());
        let drain = tokio::spawn(drain_events(
            Arc::clone(&state),
            outbound,
            client.clone(),
            events,
            1,
        ));
        register_for_history(&mut wire).await;
        let targets = next_sent_containing(&mut wire, " CHATHISTORY TARGETS ").await;
        send_recent_targets(&mut wire, request_label(&targets), &[]).await;
        wire.server(":weblounge!u@host JOIN #room").await;
        let latest = next_sent_containing(&mut wire, " CHATHISTORY LATEST #room * ").await;
        let seed_time = wire_time(papo::time::now() - Duration::from_secs(5));
        let seed = format!(
            "@batch={{batch}};time={seed_time};msgid=seed :alice!a@host PRIVMSG #room :seed"
        );
        send_ergo_history_page(&mut wire, &latest, &[&seed]).await;

        reconnect_for_history(&client, &mut wire).await;
        let targets = next_sent_containing(&mut wire, " CHATHISTORY TARGETS ").await;
        let outage_time = wire_time(papo::time::now());
        send_recent_targets(
            &mut wire,
            request_label(&targets),
            &[("#room", &outage_time)],
        )
        .await;
        let refresh =
            next_sent_containing(&mut wire, " CHATHISTORY LATEST #room msgid=seed ").await;
        let cursor_before_cut = lock(&state)
            .network
            .as_ref()
            .and_then(|running| running.model.cursor())
            .expect("the first connection settled its cursor");
        wire.server(format!(
            "@label={} :offline.test BATCH +cut chathistory #room",
            request_label(&refresh)
        ))
        .await;
        wire.server(first_item(&seed_time, &outage_time)).await;

        reconnect_for_history(&client, &mut wire).await;
        let targets = next_sent_containing(&mut wire, " CHATHISTORY TARGETS ").await;
        Self {
            wire,
            drain,
            cursor_before_cut,
            outage_time,
            targets,
        }
    }

    /// Lists `#room` with its outage as the next connection's target and returns its catch-up.
    async fn next_catch_up(mut self) -> String {
        send_recent_targets(
            &mut self.wire,
            request_label(&self.targets),
            &[("#room", &self.outage_time)],
        )
        .await;
        let again = tokio::time::timeout(
            Duration::from_secs(1),
            next_sent_containing(&mut self.wire, " CHATHISTORY LATEST #room "),
        )
        .await
        .expect("the cut-off catch-up runs again");
        self.drain.abort();
        again
    }
}

/// A catch-up page cut off by a disconnect reaches the engine as a replay of its first item.
#[tokio::test]
async fn a_catch_up_cut_off_mid_page_is_caught_up_again_on_the_next_connection() {
    let cut = CutOffCatchUp::new(|seed_time, _| {
        format!("@batch=cut;time={seed_time};msgid=rejoin :weblounge!u@host JOIN #room")
    })
    .await;

    let since = format!("timestamp={}", wire_time(cut.cursor_before_cut));
    assert!(cut.targets.contains(&since), "{}", cut.targets);
    let again = cut.next_catch_up().await;
    assert!(
        again.ends_with("CHATHISTORY LATEST #room msgid=seed 100"),
        "{again}"
    );
}

/// Ergo stamps lines sent together with one millisecond, so the replayed first line can share its
/// time with the lines the cut left out.
#[tokio::test]
async fn a_catch_up_cut_off_after_one_of_several_same_millisecond_lines_fetches_the_rest() {
    let cut = CutOffCatchUp::new(|_, outage_time| {
        format!(
            "@batch=cut;time={outage_time};msgid=outage-1 :alice!a@host PRIVMSG #room :outage 1"
        )
    })
    .await;

    let again = cut.next_catch_up().await;
    assert!(
        again.ends_with("CHATHISTORY LATEST #room msgid=seed 100"),
        "{again}"
    );
}
