use std::collections::HashMap;

use crate::ReplyParent;

/// Parents a conversation looked up in history, kept while a loaded reply names them. Enough for
/// a screenful of replies to distinct unloaded parents.
pub(crate) const MAX_FETCHED_PARENTS: usize = 64;

/// What history said about a reply's parent that is not in the loaded timeline.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FetchedParent {
    Loading,
    Fetched {
        author: String,
        nick_color_index: u32,
        text: String,
    },
    /// Keeps the author a found parent had, so its replies still hide the nick prefix.
    Deleted {
        author: Option<String>,
    },
    Missing,
}

impl FetchedParent {
    fn projection(&self) -> ReplyParent {
        match self {
            Self::Loading => ReplyParent::Loading,
            Self::Fetched {
                author,
                nick_color_index,
                text,
            } => ReplyParent::Fetched {
                author: author.clone(),
                nick_color_index: *nick_color_index,
                text: text.clone(),
            },
            Self::Deleted { .. } => ReplyParent::Deleted,
            Self::Missing => ReplyParent::Unavailable,
        }
    }

    pub(crate) fn author(&self) -> Option<&str> {
        match self {
            Self::Fetched { author, .. }
            | Self::Deleted {
                author: Some(author),
            } => Some(author),
            Self::Loading | Self::Deleted { author: None } | Self::Missing => None,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct FetchedParents {
    parents: HashMap<String, FetchedParent>,
}

impl FetchedParents {
    pub(crate) fn get(&self, msgid: &str) -> Option<&FetchedParent> {
        self.parents.get(msgid)
    }

    /// An unrequested parent is projected as loading until its lookup answers.
    pub(crate) fn projection(&self, msgid: &str) -> ReplyParent {
        self.parents
            .get(msgid)
            .map_or(ReplyParent::Loading, FetchedParent::projection)
    }

    /// Starts a lookup unless one was already made. Past the bound a parent stays loading until
    /// earlier replies leave the timeline.
    pub(crate) fn request(&mut self, msgid: &str) -> bool {
        if self.parents.contains_key(msgid) || self.parents.len() == MAX_FETCHED_PARENTS {
            return false;
        }
        self.parents
            .insert(msgid.to_owned(), FetchedParent::Loading);
        true
    }

    /// Releases parents no loaded reply names any more.
    pub(crate) fn retain(&mut self, named: impl Fn(&str) -> bool) {
        self.parents.retain(|msgid, _| named(msgid));
    }

    /// Records a lookup's answer, unless the parent was released or deleted meanwhile.
    pub(crate) fn resolve(&mut self, msgid: &str, parent: FetchedParent) -> bool {
        self.parents
            .get_mut(msgid)
            .filter(|current| **current == FetchedParent::Loading)
            .map(|current| *current = parent)
            .is_some()
    }

    /// Forgets a lookup that failed for now, so the next projection asks again.
    pub(crate) fn forget(&mut self, msgid: &str) {
        self.parents.remove(msgid);
    }

    pub(crate) fn forget_loading(&mut self) {
        self.parents
            .retain(|_, parent| *parent != FetchedParent::Loading);
    }

    pub(crate) fn redact(&mut self, msgid: &str) -> bool {
        let Some(parent) = self.parents.get_mut(msgid) else {
            return false;
        };
        let author = parent.author().map(str::to_owned);
        *parent = FetchedParent::Deleted { author };
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{FetchedParent, FetchedParents, MAX_FETCHED_PARENTS};
    use crate::ReplyParent;

    fn found(text: &str) -> FetchedParent {
        FetchedParent::Fetched {
            author: "bruno".into(),
            nick_color_index: 2,
            text: text.into(),
        }
    }

    #[test]
    fn a_parent_loads_once_and_then_shows_what_history_said() {
        let mut parents = FetchedParents::default();
        assert_eq!(parents.projection("p1"), ReplyParent::Loading);
        assert!(parents.request("p1"));
        assert!(!parents.request("p1"));

        assert!(parents.resolve("p1", found("ship it?")));

        assert_eq!(
            parents.projection("p1"),
            ReplyParent::Fetched {
                author: "bruno".into(),
                nick_color_index: 2,
                text: "ship it?".into(),
            }
        );
    }

    #[test]
    fn a_live_deletion_turns_a_fetched_parent_deleted() {
        let mut parents = FetchedParents::default();
        parents.request("p1");
        parents.resolve("p1", found("oops"));

        assert!(parents.redact("p1"));
        assert!(!parents.redact("elsewhere"));

        assert_eq!(parents.projection("p1"), ReplyParent::Deleted);
        assert_eq!(
            parents.get("p1").and_then(FetchedParent::author),
            Some("bruno")
        );
    }

    #[test]
    fn past_the_bound_a_parent_waits_until_earlier_replies_leave() {
        let mut parents = FetchedParents::default();
        for index in 0..MAX_FETCHED_PARENTS {
            assert!(parents.request(&format!("p{index}")));
        }
        assert!(!parents.request("late"));
        assert_eq!(parents.projection("late"), ReplyParent::Loading);

        parents.retain(|msgid| msgid != "p0");

        assert_eq!(parents.get("p0"), None);
        assert!(parents.request("late"));
    }

    #[test]
    fn a_parent_deleted_while_loading_stays_deleted() {
        let mut parents = FetchedParents::default();
        parents.request("p1");
        parents.redact("p1");

        assert!(!parents.resolve("p1", found("oops")));

        assert_eq!(parents.projection("p1"), ReplyParent::Deleted);
    }

    #[test]
    fn a_forgotten_lookup_is_asked_again() {
        let mut parents = FetchedParents::default();
        parents.request("p1");

        parents.forget("p1");

        assert!(parents.request("p1"));
    }

    #[test]
    fn a_replaced_connection_forgets_only_unanswered_lookups() {
        let mut parents = FetchedParents::default();
        parents.request("asked");
        parents.request("answered");
        parents.resolve("answered", FetchedParent::Missing);

        parents.forget_loading();

        assert!(parents.request("asked"));
        assert!(!parents.request("answered"));
    }
}
