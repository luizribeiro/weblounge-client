//! Design 39: random interleavings of live lines, older-page loads, other devices' read markers
//! and short server pages, against a scripted server that answers `CHATHISTORY` from an oracle.

use std::{sync::Arc, time::Duration};

use proptest::prelude::*;

use super::{
    EngineToUi, ReplayHarness, collect, known_channel, lock, next_sent_containing,
    send_ergo_history_page, spawn_history_fetch,
};
use crate::BufferId;

const CAPS: &str =
    "draft/chathistory draft/read-marker labeled-response batch server-time message-tags";
const PAGE_TIMEOUT: Duration = Duration::from_secs(5);

/// The server's history of `#room`: line `i` has msgid `m{i}` and is stamped `i` seconds after
/// 10:00, so time order and oracle order agree.
struct Oracle {
    lines: usize,
    page_cap: usize,
}

impl Oracle {
    fn time(index: usize) -> String {
        let seconds = 10 * 3600 + index;
        format!(
            "2026-10-27T{:02}:{:02}:{:02}.000Z",
            seconds / 3600,
            seconds / 60 % 60,
            seconds % 60
        )
    }

    fn body(index: usize) -> String {
        format!(
            "time={};msgid=m{index} :alice!a@host PRIVMSG #room :line {index}",
            Self::time(index)
        )
    }

    fn append(&mut self) -> String {
        let line = format!("@{}", Self::body(self.lines));
        self.lines += 1;
        line
    }

    /// The engine only pages this conversation with `LATEST *` and `BEFORE msgid=…`; a server may
    /// return fewer lines than asked for.
    fn page(&self, request: &str) -> Vec<String> {
        let words: Vec<&str> = request.split(' ').collect();
        let at = words
            .iter()
            .position(|word| *word == "CHATHISTORY")
            .expect("a CHATHISTORY request");
        let limit: usize = words
            .last()
            .and_then(|word| word.parse().ok())
            .expect("a page limit");
        let limit = limit.min(self.page_cap);
        let end = match (words[at + 1], words[at + 3]) {
            ("LATEST", "*") => self.lines,
            ("BEFORE", reference) => reference
                .strip_prefix("msgid=m")
                .and_then(|index| index.parse().ok())
                .expect("an oracle msgid"),
            (subcommand, reference) => panic!("unscripted CHATHISTORY {subcommand} {reference}"),
        };
        (end.saturating_sub(limit)..end)
            .map(|index| format!("@batch={{batch}};{}", Self::body(index)))
            .collect()
    }
}

#[derive(Clone, Debug)]
enum Step {
    Live(usize),
    MarkerAt(usize),
    LoadOlder { live_meanwhile: usize },
}

fn step() -> impl Strategy<Value = Step> {
    prop_oneof![
        (1..4_usize).prop_map(Step::Live),
        (0..400_usize).prop_map(Step::MarkerAt),
        (0..3_usize).prop_map(|live_meanwhile| Step::LoadOlder { live_meanwhile }),
    ]
}

#[derive(Clone, Debug)]
struct Scenario {
    before_join: usize,
    page_cap: usize,
    live_before_latest: usize,
    steps: Vec<Step>,
}

/// Runs stay under the 50-row window the test harness gives the engine, which evicts beyond it.
fn scenario() -> impl Strategy<Value = Scenario> {
    (
        0..24_usize,
        prop_oneof![Just(3_usize), Just(10), Just(100)],
        0..4_usize,
        prop::collection::vec(step(), 0..7),
    )
        .prop_map(
            |(before_join, page_cap, live_before_latest, steps)| Scenario {
                before_join,
                page_cap,
                live_before_latest,
                steps,
            },
        )
}

struct Run {
    harness: ReplayHarness,
    oracle: Oracle,
}

impl Run {
    async fn live(&mut self, count: usize) {
        for _ in 0..count {
            let line = self.oracle.append();
            self.harness.wire.server(line).await;
        }
    }

    async fn answer(&mut self, request: &str) {
        _ = collect(&mut self.harness.receiver);
        let items = self.oracle.page(request);
        let items: Vec<&str> = items.iter().map(String::as_str).collect();
        send_ergo_history_page(&mut self.harness.wire, request, &items).await;
        self.page_applied().await;
    }

    async fn page_applied(&mut self) {
        let buffer = self.buffer_id();
        tokio::time::timeout(PAGE_TIMEOUT, async {
            loop {
                let event = self
                    .harness
                    .receiver
                    .recv()
                    .await
                    .expect("runtime remains active");
                if matches!(
                    event,
                    EngineToUi::HistoryStateChanged { buffer_id, loading: false, .. }
                        if buffer_id == buffer
                ) {
                    return;
                }
            }
        })
        .await
        .expect("the history page is applied");
    }

    /// Every earlier wire line is applied once a later live line shows in the timeline.
    async fn live_applied(&mut self) {
        let sentinel = format!("line {}", self.oracle.lines);
        self.live(1).await;
        _ = self.harness.timeline_output(&[sentinel.as_str()]).await;
    }

    fn buffer_id(&self) -> BufferId {
        let state = lock(&self.harness.state);
        let model = &state
            .network
            .as_ref()
            .expect("network remains active")
            .model;
        model
            .buffer_id_for_channel(&known_channel(&self.harness.client, "#room"))
            .expect("channel buffer")
    }

    async fn load_older(&mut self, live_meanwhile: usize) -> bool {
        let buffer_id = self.buffer_id();
        let fetch = lock(&self.harness.state)
            .network
            .as_mut()
            .expect("network remains active")
            .model
            .request_history(buffer_id, crate::HistoryDirection::Older);
        let Some(fetch) = fetch else {
            return false;
        };
        spawn_history_fetch(
            Arc::clone(&self.harness.state),
            self.harness.outbound.clone(),
            self.harness.client.clone(),
            1,
            fetch,
            None,
        );
        let request = next_sent_containing(&mut self.harness.wire, "CHATHISTORY BEFORE").await;
        self.live(live_meanwhile).await;
        self.answer(&request).await;
        true
    }

    async fn marker_at(&mut self, index: usize) {
        if self.oracle.lines == 0 {
            return;
        }
        let time = Oracle::time(index % self.oracle.lines);
        self.harness
            .wire
            .server(format!(":offline.test MARKREAD #room timestamp={time}"))
            .await;
    }

    fn rows_and_gaps(&self) -> (Vec<String>, Vec<(i64, i64)>) {
        let buffer_id = self.buffer_id();
        let state = lock(&self.harness.state);
        let model = &state
            .network
            .as_ref()
            .expect("network remains active")
            .model;
        let rows = model
            .projected_messages(buffer_id)
            .into_iter()
            .flat_map(|message| message.server_ids)
            .collect();
        (rows, model.projected_gaps(buffer_id))
    }
}

async fn run(scenario: Scenario) -> (Vec<String>, Vec<(i64, i64)>, usize) {
    let mut oracle = Oracle {
        lines: 0,
        page_cap: scenario.page_cap,
    };
    for _ in 0..scenario.before_join {
        _ = oracle.append();
    }
    let mut run = Run {
        harness: ReplayHarness::joined(CAPS).await,
        oracle,
    };
    let latest = next_sent_containing(&mut run.harness.wire, "CHATHISTORY LATEST #room").await;
    run.live(scenario.live_before_latest).await;
    run.answer(&latest).await;
    for step in scenario.steps {
        match step {
            Step::Live(count) => run.live(count).await,
            Step::MarkerAt(index) => run.marker_at(index).await,
            Step::LoadOlder { live_meanwhile } => _ = run.load_older(live_meanwhile).await,
        }
    }
    run.live_applied().await;
    while run.load_older(0).await {}
    let (rows, gaps) = run.rows_and_gaps();
    run.harness.drain.abort();
    (rows, gaps, run.oracle.lines)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// With one connection nothing can be missed, so after paging back to the start every oracle
    /// line shows once, in order, with no gap row.
    #[test]
    fn message_rows_cover_the_servers_history_exactly(scenario in scenario()) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let (rows, gaps, lines) = runtime.block_on(run(scenario));
        prop_assert_eq!(rows, (0..lines).map(|index| format!("m{index}")).collect::<Vec<_>>());
        prop_assert!(gaps.is_empty(), "gap rows {:?}", gaps);
    }
}
