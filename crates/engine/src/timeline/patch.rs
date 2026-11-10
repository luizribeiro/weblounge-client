use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::MessageId;

use super::{TimelineError, TimelineItem};

/// One atomic timeline patch.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct TimelineChange {
    /// Replace the mirror instead of reconciling retained rows.
    pub reset: bool,
    /// Complete current items in engine order.
    pub upserted: Vec<TimelineItem>,
    /// Identities no longer present in the engine projection.
    pub removed: Vec<MessageId>,
}

/// Geometry effect used by the eventual UI rendering path.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum GeometryClass {
    /// Only new items after the previous end were inserted.
    Suffix,
    /// Only new items before the previous start were inserted.
    Prefix,
    /// Existing identities were replaced without moving.
    InPlace,
    /// Rows were removed, moved, or changed in more than one region.
    Mixed,
}

/// Complete result of diffing the prior emission with a desired projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimelineDiff {
    /// Complete normalized items after assigning revisions.
    pub items: Vec<TimelineItem>,
    /// Minimal patch from the prior emission.
    pub change: TimelineChange,
}

/// Result of applying a patch to the Rust reducer mirror.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppliedTimeline {
    /// Complete mirror state after atomic application.
    pub items: Vec<TimelineItem>,
    /// Geometry effect relative to the prior mirror state.
    pub geometry: GeometryClass,
}

/// Assigns content versions and produces the smallest identity-based patch.
///
/// # Errors
///
/// Returns [`TimelineError`] for duplicate identities, unsorted input, or version overflow.
pub fn diff(
    previous: &[TimelineItem],
    desired: &[TimelineItem],
) -> Result<TimelineDiff, TimelineError> {
    validate_items(previous)?;
    validate_items(desired)?;
    let previous_by_id: HashMap<_, _> = previous.iter().map(|item| (item.id, item)).collect();
    let desired_ids: HashSet<_> = desired.iter().map(|item| item.id).collect();
    let mut items = Vec::with_capacity(desired.len());
    let mut upserted = Vec::new();

    for candidate in desired {
        let mut item = candidate.clone();
        if let Some(known) = previous_by_id.get(&item.id) {
            let content_changed = known.day != item.day || known.body != item.body;
            item.content_version = if content_changed {
                known
                    .content_version
                    .checked_add(1)
                    .ok_or(TimelineError::ContentVersionOverflow(item.id))?
            } else {
                known.content_version
            };
            if content_changed || known.order != item.order {
                upserted.push(item.clone());
            }
        } else {
            item.content_version = 0;
            upserted.push(item.clone());
        }
        items.push(item);
    }

    let removed = previous
        .iter()
        .filter(|item| !desired_ids.contains(&item.id))
        .map(|item| item.id)
        .collect();
    Ok(TimelineDiff {
        items,
        change: TimelineChange {
            reset: false,
            upserted,
            removed,
        },
    })
}

/// Applies one patch with the same ordering rules as the TypeScript reducer.
///
/// # Errors
///
/// Returns [`TimelineError`] when the current list or patch is ambiguous or unsorted.
pub fn apply_timeline_change(
    current: &[TimelineItem],
    change: &TimelineChange,
) -> Result<AppliedTimeline, TimelineError> {
    validate_items(current)?;
    validate_patch(change)?;
    if change.reset {
        return Ok(AppliedTimeline {
            items: change.upserted.clone(),
            geometry: GeometryClass::Mixed,
        });
    }

    let geometry = geometry_class(current, change);
    let removed: HashSet<_> = change.removed.iter().copied().collect();
    let upserted: HashSet<_> = change.upserted.iter().map(|item| item.id).collect();
    let mut items: Vec<_> = current
        .iter()
        .filter(|item| !removed.contains(&item.id) && !upserted.contains(&item.id))
        .cloned()
        .collect();
    for item in &change.upserted {
        let index = items
            .binary_search_by_key(&item.order, |known| known.order)
            .unwrap_or_else(|index| index);
        items.insert(index, item.clone());
    }
    validate_items(&items)?;
    Ok(AppliedTimeline { items, geometry })
}

fn geometry_class(current: &[TimelineItem], change: &TimelineChange) -> GeometryClass {
    if !change.removed.is_empty() {
        return GeometryClass::Mixed;
    }
    let by_id: HashMap<_, _> = current.iter().map(|item| (item.id, item)).collect();
    if change.upserted.iter().all(|item| {
        by_id
            .get(&item.id)
            .is_some_and(|known| known.order == item.order)
    }) {
        return GeometryClass::InPlace;
    }
    if change
        .upserted
        .iter()
        .any(|item| by_id.contains_key(&item.id))
    {
        return GeometryClass::Mixed;
    }
    if current.is_empty() {
        return GeometryClass::Suffix;
    }
    if change
        .upserted
        .first()
        .zip(current.last())
        .is_some_and(|(item, last)| item.order > last.order)
    {
        return GeometryClass::Suffix;
    }
    if change
        .upserted
        .last()
        .is_some_and(|item| item.order < current[0].order)
    {
        return GeometryClass::Prefix;
    }
    GeometryClass::Mixed
}

fn validate_patch(change: &TimelineChange) -> Result<(), TimelineError> {
    validate_items(&change.upserted)?;
    let mut removed = HashSet::with_capacity(change.removed.len());
    for id in &change.removed {
        if !removed.insert(*id) {
            return Err(TimelineError::DuplicateId(*id));
        }
    }
    if let Some(id) = change
        .upserted
        .iter()
        .map(|item| item.id)
        .find(|id| removed.contains(id))
    {
        return Err(TimelineError::ConflictingPatchId(id));
    }
    Ok(())
}

fn validate_items(items: &[TimelineItem]) -> Result<(), TimelineError> {
    if items.windows(2).any(|pair| pair[0].order >= pair[1].order) {
        return Err(TimelineError::UnsortedItems);
    }
    let mut ids = HashSet::with_capacity(items.len());
    for item in items {
        if !ids.insert(item.id) {
            return Err(TimelineError::DuplicateId(item.id));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::MessageId;

    use super::{GeometryClass, TimelineChange, apply_timeline_change, diff};
    use crate::timeline::{
        GapProjection, ItemBody, LocalDay, OrderKey, TimelineError, TimelineItem,
    };

    fn item(id: u64, primary_ms: i64, from_ms: i64) -> TimelineItem {
        TimelineItem {
            id: MessageId(id),
            order: OrderKey::new(primary_ms, primary_ms, id),
            day: LocalDay(1),
            content_version: 99,
            body: ItemBody::Gap(GapProjection {
                from_ms,
                to_ms: from_ms + 1,
            }),
        }
    }

    #[test]
    fn diff_versions_content_but_not_order_movement() {
        let previous = [TimelineItem {
            content_version: 4,
            ..item(1, 10, 10)
        }];
        let moved = diff(&previous, &[item(1, 20, 10)]).expect("valid move");
        assert_eq!(moved.items[0].content_version, 4);
        assert_eq!(moved.change.upserted, moved.items);

        let changed = diff(&moved.items, &[item(1, 20, 11)]).expect("valid update");
        assert_eq!(changed.items[0].content_version, 5);
    }

    #[test]
    fn reducer_applies_suffix_atomically_and_rejects_conflicts() {
        let current = [item(1, 10, 10)];
        let change = TimelineChange {
            reset: false,
            upserted: vec![item(2, 20, 20)],
            removed: Vec::new(),
        };
        let applied = apply_timeline_change(&current, &change).expect("valid suffix");
        assert_eq!(applied.geometry, GeometryClass::Suffix);
        assert_eq!(
            applied.items.iter().map(|item| item.id).collect::<Vec<_>>(),
            [MessageId(1), MessageId(2)]
        );

        let conflict = TimelineChange {
            removed: vec![MessageId(2)],
            ..change
        };
        assert_eq!(
            apply_timeline_change(&current, &conflict),
            Err(TimelineError::ConflictingPatchId(MessageId(2))),
        );
    }
}
