use super::{BufferId, BufferState, HistoryTarget, NetworkModel, RecordBody};

/// One gap backfill in flight per buffer; a request while it loads asks for the next page.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) enum GapFill {
    #[default]
    Idle,
    Loading {
        attempt: u64,
        requested_again: bool,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct GapSpan {
    pub(crate) from_ms: i64,
    pub(crate) to_ms: i64,
}

#[derive(Clone, Debug)]
pub(crate) struct GapFetch {
    pub(crate) target: HistoryTarget,
    pub(crate) span: GapSpan,
    attempt: u64,
}

/// Ergo fills a page by walking lines in the order it stored them, and it stores a line only after
/// fanning it out, so concurrent senders' lines sit out of stamp order by up to a millisecond or
/// so. A line stamped just after the oldest line of the page that bounded the gap can be stored
/// before that page's lines and left out of it; reaching this far past the gap's newer edge brings
/// it in, along with lines already shown, which merge by msgid.
const EDGE_OVERLAP_MS: i64 = 10;

impl GapFetch {
    pub(crate) fn before(&self) -> Option<papo::ServerTime> {
        papo::ServerTime::from_stored_millis(self.span.to_ms.saturating_add(EDGE_OVERLAP_MS)).ok()
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct GapPage {
    pub(crate) oldest_time_ms: Option<i64>,
    pub(crate) item_count: usize,
    pub(crate) end: bool,
}

impl GapPage {
    /// `backfill_gaps` keeps what lies before the time it is given, so a page that reaches the
    /// gap's older edge reports a time just past it.
    fn covered_from(self, span: GapSpan) -> i64 {
        let past_older_edge = span.from_ms.saturating_sub(1);
        if self.end || self.item_count == 0 {
            return past_older_edge;
        }
        match self.oldest_time_ms {
            Some(oldest) if oldest > span.from_ms => oldest,
            Some(oldest) => oldest.min(past_older_edge),
            None => past_older_edge,
        }
    }
}

impl NetworkModel {
    pub(crate) fn begin_gap_fill(&mut self, buffer_id: BufferId) -> Option<GapFetch> {
        let buffer = self.buffers.get_mut(&buffer_id)?;
        if let GapFill::Loading {
            requested_again, ..
        } = &mut buffer.gap_fill
        {
            *requested_again = true;
            return None;
        }
        let target = HistoryTarget::from_key(buffer.key.clone()?);
        let span = newest_gap(buffer)?;
        let attempt = self.next_gap_fill_attempt;
        self.next_gap_fill_attempt += 1;
        buffer.gap_fill = GapFill::Loading {
            attempt,
            requested_again: false,
        };
        Some(GapFetch {
            target,
            span,
            attempt,
        })
    }

    /// A page that left the gap as it was (a millisecond holding more than a page) is not fetched
    /// again, which would never end.
    pub(crate) fn finish_gap_fill(
        &mut self,
        fetch: &GapFetch,
        page: GapPage,
    ) -> (Option<BufferId>, Option<GapFetch>) {
        let Some(buffer_id) = self.names.get(&fetch.target.name_key()).copied() else {
            return (None, None);
        };
        self.backfill_gaps(buffer_id, page.covered_from(fetch.span), fetch.span.to_ms);
        let again = self.settle_gap_fill(buffer_id, fetch.attempt);
        let progressed = self
            .buffers
            .get(&buffer_id)
            .is_some_and(|buffer| newest_gap(buffer) != Some(fetch.span));
        let next = (again && progressed)
            .then(|| self.begin_gap_fill(buffer_id))
            .flatten();
        (Some(buffer_id), next)
    }

    pub(crate) fn fail_gap_fill(&mut self, fetch: &GapFetch) {
        if let Some(buffer_id) = self.names.get(&fetch.target.name_key()).copied() {
            self.settle_gap_fill(buffer_id, fetch.attempt);
        }
    }

    pub(super) fn reset_gap_fills(&mut self) {
        for buffer in self.buffers.values_mut() {
            buffer.gap_fill = GapFill::Idle;
        }
    }

    fn settle_gap_fill(&mut self, buffer_id: BufferId, attempt: u64) -> bool {
        let Some(buffer) = self.buffers.get_mut(&buffer_id) else {
            return false;
        };
        let GapFill::Loading {
            attempt: loading,
            requested_again,
        } = buffer.gap_fill
        else {
            return false;
        };
        if loading != attempt {
            return false;
        }
        buffer.gap_fill = GapFill::Idle;
        requested_again
    }

    #[cfg(test)]
    pub(crate) fn gap_fill_loading(&self, buffer_id: BufferId) -> bool {
        self.buffers
            .get(&buffer_id)
            .is_some_and(|buffer| matches!(buffer.gap_fill, GapFill::Loading { .. }))
    }
}

fn newest_gap(buffer: &BufferState) -> Option<GapSpan> {
    buffer
        .timeline
        .iter()
        .filter_map(|record| match &record.body {
            RecordBody::Gap(gap) => Some(GapSpan {
                from_ms: gap.from_ms,
                to_ms: gap.to_ms,
            }),
            _ => None,
        })
        .max_by_key(|span| span.to_ms)
}

#[cfg(test)]
mod tests {
    use super::{GapPage, GapSpan};
    use crate::BufferId;
    use crate::state::{
        NameKey, NetworkModel,
        tests::{channel_name, gaps, model},
    };

    fn channel_with_gaps(spans: &[(i64, i64)]) -> (NetworkModel, BufferId) {
        let (mut model, state) = model(10);
        let channel = channel_name(&state, "#room");
        let (buffer_id, _) = model.ensure_buffer(NameKey::Channel(channel), None, None);
        for &(from_ms, to_ms) in spans {
            model.record_gap(buffer_id, from_ms, to_ms).expect("gap");
        }
        (model, buffer_id)
    }

    fn page(oldest_time_ms: Option<i64>, item_count: usize) -> GapPage {
        GapPage {
            oldest_time_ms,
            item_count,
            end: false,
        }
    }

    #[test]
    fn fills_the_newest_gap_first_and_fetches_before_its_newer_edge() {
        let (mut model, buffer_id) = channel_with_gaps(&[(100, 200), (500, 700)]);

        let fetch = model.begin_gap_fill(buffer_id).expect("gap fetch");

        assert_eq!(
            fetch.span,
            GapSpan {
                from_ms: 500,
                to_ms: 700
            }
        );
        assert_eq!(fetch.before().map(papo::ServerTime::as_millis), Some(710));
    }

    #[test]
    fn a_page_reaching_the_older_edge_clears_the_gap() {
        let (mut model, buffer_id) = channel_with_gaps(&[(100, 200), (500, 700)]);
        let fetch = model.begin_gap_fill(buffer_id).expect("gap fetch");

        let (filled, next) = model.finish_gap_fill(&fetch, page(Some(480), 30));

        assert_eq!(filled, Some(buffer_id));
        assert!(next.is_none());
        assert_eq!(gaps(&model, buffer_id), vec![(100, 200)]);
    }

    #[test]
    fn an_empty_or_final_page_clears_the_gap() {
        for finished in [
            page(None, 0),
            GapPage {
                end: true,
                ..page(Some(650), 4)
            },
        ] {
            let (mut model, buffer_id) = channel_with_gaps(&[(500, 700)]);
            let fetch = model.begin_gap_fill(buffer_id).expect("gap fetch");

            model.finish_gap_fill(&fetch, finished);

            assert!(gaps(&model, buffer_id).is_empty());
        }
    }

    #[test]
    fn a_full_page_shrinks_the_gap_to_what_it_did_not_reach() {
        let (mut model, buffer_id) = channel_with_gaps(&[(500, 700)]);
        let fetch = model.begin_gap_fill(buffer_id).expect("gap fetch");

        let (_, next) = model.finish_gap_fill(&fetch, page(Some(600), 100));

        assert!(next.is_none());
        assert_eq!(gaps(&model, buffer_id), vec![(500, 600)]);
        let again = model.begin_gap_fill(buffer_id).expect("next page");
        assert_eq!(
            again.span,
            GapSpan {
                from_ms: 500,
                to_ms: 600
            }
        );
    }

    #[test]
    fn a_request_while_loading_fetches_the_next_page_when_it_lands() {
        let (mut model, buffer_id) = channel_with_gaps(&[(500, 700)]);
        let fetch = model.begin_gap_fill(buffer_id).expect("gap fetch");

        assert!(model.begin_gap_fill(buffer_id).is_none());
        let (_, next) = model.finish_gap_fill(&fetch, page(Some(600), 100));

        assert_eq!(
            next.map(|next| next.span),
            Some(GapSpan {
                from_ms: 500,
                to_ms: 600
            })
        );
    }

    #[test]
    fn a_gap_that_grew_while_loading_keeps_its_unfilled_older_part() {
        let (mut model, buffer_id) = channel_with_gaps(&[(500, 700)]);
        let fetch = model.begin_gap_fill(buffer_id).expect("gap fetch");
        model.record_gap(buffer_id, 300, 500).expect("merged gap");

        model.finish_gap_fill(&fetch, page(Some(450), 10));

        assert_eq!(gaps(&model, buffer_id), vec![(300, 450)]);
    }

    #[test]
    fn a_failed_fill_keeps_the_gap_and_lets_the_next_catch_up_retry() {
        let (mut model, buffer_id) = channel_with_gaps(&[(500, 700)]);
        let fetch = model.begin_gap_fill(buffer_id).expect("gap fetch");

        model.fail_gap_fill(&fetch);

        assert_eq!(gaps(&model, buffer_id), vec![(500, 700)]);
        assert!(model.begin_gap_fill(buffer_id).is_some());
    }

    #[test]
    fn a_restarted_connection_lets_a_stale_fill_retry() {
        let (mut model, buffer_id) = channel_with_gaps(&[(500, 700)]);
        let stale = model.begin_gap_fill(buffer_id).expect("gap fetch");

        model.restart_inflight_history();
        let retry = model.begin_gap_fill(buffer_id).expect("retry");
        model.fail_gap_fill(&stale);

        assert!(model.begin_gap_fill(buffer_id).is_none());
        assert_eq!(retry.span, stale.span);
    }

    #[test]
    fn a_buffer_without_gaps_fetches_nothing() {
        let (mut model, buffer_id) = channel_with_gaps(&[]);

        assert!(model.begin_gap_fill(buffer_id).is_none());
    }

    #[test]
    fn a_page_that_makes_no_progress_is_not_fetched_again() {
        let (mut model, buffer_id) = channel_with_gaps(&[(500, 700)]);
        let fetch = model.begin_gap_fill(buffer_id).expect("gap fetch");
        assert!(model.begin_gap_fill(buffer_id).is_none());

        let (_, next) = model.finish_gap_fill(&fetch, page(Some(700), 100));

        assert!(next.is_none());
        assert_eq!(gaps(&model, buffer_id), vec![(500, 700)]);
        assert!(!model.gap_fill_loading(buffer_id));
    }

    #[test]
    fn a_failed_fill_drops_a_request_made_while_it_loaded() {
        let (mut model, buffer_id) = channel_with_gaps(&[(500, 700)]);
        let fetch = model.begin_gap_fill(buffer_id).expect("gap fetch");
        assert!(model.begin_gap_fill(buffer_id).is_none());

        model.fail_gap_fill(&fetch);

        assert!(!model.gap_fill_loading(buffer_id));
    }
}
