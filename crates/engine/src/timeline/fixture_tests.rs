use serde::Deserialize;

use super::{GeometryClass, TimelineChange, TimelineItem, apply_timeline_change};

const REDUCER_FIXTURES: &str = include_str!("../../../../fixtures/timeline/reducer.json");

#[derive(Debug, Deserialize)]
struct FixtureFile {
    version: u8,
    cases: Vec<FixtureCase>,
}

#[derive(Debug, Deserialize)]
struct FixtureCase {
    name: String,
    initial: Vec<TimelineItem>,
    change: TimelineChange,
    expected_items: Vec<TimelineItem>,
    geometry: GeometryClass,
}

#[test]
fn shared_json_fixtures_cover_the_reducer_contract() {
    let fixtures: FixtureFile = serde_json::from_str(REDUCER_FIXTURES).expect("valid fixtures");
    assert_eq!(fixtures.version, 1);
    assert_eq!(fixtures.cases.len(), 9);

    for case in fixtures.cases {
        let applied = apply_timeline_change(&case.initial, &case.change)
            .unwrap_or_else(|error| panic!("fixture {} failed: {error}", case.name));
        assert_eq!(applied.items, case.expected_items, "fixture {}", case.name);
        assert_eq!(applied.geometry, case.geometry, "fixture {}", case.name);
    }
}
