use std::collections::{HashMap, HashSet};

use proptest::prelude::*;

use crate::MessageId;

use super::{
    FoldEvent, FoldedBody, ItemBody, LocalDay, OrderKey, RecordBody, SystemLine, SystemProjection,
    TimelineItem, TimelineRecord, Who, apply_timeline_change, diff, fold,
};

type Scenario = (Vec<i64>, Vec<Vec<usize>>, usize);

fn scenario() -> impl Strategy<Value = Scenario> {
    prop::collection::btree_set(1_i64..10_000, 1..24).prop_flat_map(|times| {
        let times: Vec<_> = times.into_iter().collect();
        let count = times.len();
        (
            Just(times),
            prop::collection::vec(prop::collection::vec(0..count, 0..count * 2), 1..10),
            1..=count.min(6),
        )
    })
}

fn ingest_page(
    times: &[i64],
    page: &[usize],
    allocated: &mut HashMap<usize, TimelineRecord>,
    retained: &mut HashMap<usize, TimelineRecord>,
) {
    for &event in page {
        let next_id = u64::try_from(allocated.len() + 1).expect("bounded generated events");
        let record = allocated
            .entry(event)
            .or_insert_with(|| TimelineRecord {
                id: MessageId(next_id),
                order: OrderKey::new(times[event], times[event] + 10_000, next_id),
                day: LocalDay(1),
                body: RecordBody::Fold(FoldEvent::Joined(Who {
                    nick: format!("nick-{event}"),
                    key: format!("nick-{event}"),
                    nick_color_index: 0,
                    own: false,
                    msgid: Some(format!("msgid-{event}")),
                })),
            })
            .clone();
        retained.insert(event, record);
    }
}

fn folded_items(records: &HashMap<usize, TimelineRecord>) -> Vec<TimelineItem> {
    let mut records: Vec<_> = records.values().cloned().collect();
    records.sort_unstable_by_key(|record| record.order);
    fold(&records)
        .expect("generated records are valid")
        .into_iter()
        .map(|item| {
            let FoldedBody::Run(run) = item.body else {
                unreachable!("generated records are fold events");
            };
            TimelineItem {
                id: item.id,
                order: item.order,
                day: item.day,
                content_version: 0,
                body: ItemBody::System(SystemProjection {
                    time_ms: run.newest_time_ms(),
                    line: SystemLine::Run {
                        clauses: run.clauses().clone(),
                    },
                }),
            }
        })
        .collect()
}

fn with_final_page(times: &[i64], pages: &[Vec<usize>]) -> Vec<Vec<usize>> {
    let mut pages = pages.to_vec();
    pages.push((0..times.len()).rev().collect());
    pages
}

proptest! {
    #[test]
    fn live_and_shuffled_history_have_the_same_folded_rows(
        (times, _, _) in scenario(),
    ) {
        let mut live_allocated = HashMap::new();
        let mut live = HashMap::new();
        ingest_page(
            &times,
            &(0..times.len()).collect::<Vec<_>>(),
            &mut live_allocated,
            &mut live,
        );
        let mut history_allocated = HashMap::new();
        let mut history = HashMap::new();
        ingest_page(
            &times,
            &(0..times.len()).rev().collect::<Vec<_>>(),
            &mut history_allocated,
            &mut history,
        );
        let normalize = |records: &HashMap<usize, TimelineRecord>| {
            folded_items(records)
                .into_iter()
                .map(|item| (item.day, item.body))
                .collect::<Vec<_>>()
        };
        prop_assert_eq!(normalize(&live), normalize(&history));
    }

    #[test]
    fn emitted_patches_keep_the_mirror_equal_to_engine_plus_silent_evictions(
        (times, pages, window) in scenario(),
    ) {
        let mut allocated = HashMap::new();
        let mut retained = HashMap::new();
        let mut engine_items = Vec::new();
        let mut mirror = Vec::new();
        let mut ever_emitted = HashMap::new();

        for page in with_final_page(&times, &pages) {
            ingest_page(&times, &page, &mut allocated, &mut retained);
            let desired = folded_items(&retained);
            let timeline_diff = diff(&engine_items, &desired).expect("valid generated diff");
            mirror = apply_timeline_change(&mirror, &timeline_diff.change)
                .expect("valid generated patch")
                .items;
            for item in &timeline_diff.items {
                ever_emitted.insert(item.id, item.clone());
            }

            let keep_from = timeline_diff.items.len().saturating_sub(window);
            engine_items = timeline_diff.items[keep_from..].to_vec();
            let retained_ids: HashSet<_> = engine_items.iter().map(|item| item.id).collect();
            retained.retain(|_, record| retained_ids.contains(&record.id));

            let mut expected: Vec<_> = ever_emitted.values().cloned().collect();
            expected.sort_unstable_by_key(|item| item.order);
            prop_assert_eq!(&mirror, &expected);
        }
    }

    #[test]
    fn surviving_fold_ids_keep_naming_their_smallest_record(
        (times, pages, window) in scenario(),
    ) {
        let mut allocated = HashMap::new();
        let mut retained = HashMap::new();
        let mut stable_owner = HashMap::new();

        for page in with_final_page(&times, &pages) {
            ingest_page(&times, &page, &mut allocated, &mut retained);
            let mut records: Vec<_> = retained.values().cloned().collect();
            records.sort_unstable_by_key(|record| record.order);
            let items = fold(&records).expect("valid generated fold");
            let mut represented = HashSet::new();

            for item in &items {
                let smallest = item.record_ids().iter().min_by_key(|id| id.0).expect("non-empty item");
                prop_assert_eq!(&item.id, smallest);
                for record_id in item.record_ids() {
                    prop_assert!(represented.insert(*record_id));
                    let owner = stable_owner.entry(*record_id).or_insert(item.id);
                    prop_assert_eq!(*owner, item.id);
                }
            }

            let keep_from = items.len().saturating_sub(window);
            let retained_ids: HashSet<_> = items[keep_from..]
                .iter()
                .flat_map(|item| item.record_ids().iter().copied())
                .collect();
            retained.retain(|_, record| retained_ids.contains(&record.id));
        }
    }
}
