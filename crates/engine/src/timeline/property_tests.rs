use std::collections::{HashMap, HashSet};

use proptest::prelude::*;

use crate::MessageId;

use super::{
    FoldEvent, GapProjection, ItemBody, LocalDay, OrderKey, RecordBody, TimelineItem,
    TimelineRecord, Who, apply_timeline_change, diff, fold,
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
        .map(|item| TimelineItem {
            id: item.id,
            order: item.order,
            day: item.day,
            content_version: 0,
            body: ItemBody::Gap(GapProjection {
                from_ms: item.order.primary_ms(),
                to_ms: item.order.primary_ms() + 1,
            }),
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
