#![allow(missing_docs)]

use std::collections::HashMap;

use super::{
    Actor, Departure, FoldEvent, NickChange, OrderKey, Person, RunClause, RunClauses, Who,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FoldRun {
    pub(crate) clauses: RunClauses,
    pub(crate) newest_time_ms: i64,
}

impl FoldRun {
    #[must_use]
    pub fn clauses(&self) -> &RunClauses {
        &self.clauses
    }

    #[must_use]
    pub const fn newest_time_ms(&self) -> i64 {
        self.newest_time_ms
    }
}

#[derive(Clone)]
enum MembershipEvent {
    Join,
    Part(Option<String>),
    Quit(Option<String>),
}

struct MembershipState {
    position: usize,
    first: MembershipEvent,
    last: MembershipEvent,
    who: Who,
}

struct NickChain {
    position: usize,
    old: Who,
    new: Who,
}

struct PositionedClause {
    position: usize,
    clause: RunClause,
}

pub(crate) fn collapse_run<'a>(
    events: impl Iterator<Item = (OrderKey, &'a FoldEvent)>,
) -> Option<FoldRun> {
    let mut events: Vec<_> = events.collect();
    events.sort_by(|(left_order, left), (right_order, right)| {
        (left_order.primary_ms(), event_msgid(left), left_order).cmp(&(
            right_order.primary_ms(),
            event_msgid(right),
            right_order,
        ))
    });
    let newest_time_ms = events.iter().map(|(order, _)| order.primary_ms()).max()?;
    let mut memberships = Vec::<MembershipState>::new();
    let mut membership_indexes = HashMap::<String, usize>::new();
    let mut nick_chains = Vec::<NickChain>::new();
    let mut clauses = Vec::<PositionedClause>::new();

    for (position, (_, event)) in events.into_iter().enumerate() {
        match event {
            FoldEvent::Joined(who) => record_membership(
                &mut memberships,
                &mut membership_indexes,
                position,
                who,
                MembershipEvent::Join,
            ),
            FoldEvent::Parted(who, reason) => record_membership(
                &mut memberships,
                &mut membership_indexes,
                position,
                who,
                MembershipEvent::Part(reason.clone()),
            ),
            FoldEvent::Quit(who, reason, _) => record_membership(
                &mut memberships,
                &mut membership_indexes,
                position,
                who,
                MembershipEvent::Quit(reason.clone()),
            ),
            FoldEvent::Nick { old, new } => record_nick(&mut nick_chains, position, old, new),
            FoldEvent::Modes { actor, changes } => {
                append_modes(&mut clauses, position, actor, changes);
            }
            FoldEvent::Invited { actor, subject } => {
                append_invited(&mut clauses, position, actor, subject);
            }
        }
    }
    for membership in &memberships {
        append_membership(&mut clauses, membership);
    }
    append_nicks(&mut clauses, nick_chains);
    clauses.sort_by_key(|clause| clause.position);
    let mut clauses = clauses.into_iter().map(|clause| clause.clause);
    let first = clauses.next()?;
    Some(FoldRun {
        clauses: RunClauses::new(first, clauses.collect()),
        newest_time_ms,
    })
}

fn event_msgid(event: &FoldEvent) -> Option<&str> {
    match event {
        FoldEvent::Joined(who) | FoldEvent::Parted(who, _) | FoldEvent::Quit(who, _, _) => {
            who.msgid.as_deref()
        }
        FoldEvent::Nick { old, new } => old.msgid.as_deref().or(new.msgid.as_deref()),
        FoldEvent::Invited { subject, .. } => subject.msgid.as_deref(),
        FoldEvent::Modes { .. } => None,
    }
}

fn person(who: &Who) -> Person {
    Person {
        nick: who.nick.clone(),
        nick_color_index: who.nick_color_index,
        me: who.own,
    }
}

fn record_membership(
    states: &mut Vec<MembershipState>,
    indexes: &mut HashMap<String, usize>,
    position: usize,
    who: &Who,
    event: MembershipEvent,
) {
    if let Some(index) = indexes.get(&who.key).copied() {
        states[index].last = event;
        states[index].who = who.clone();
    } else {
        indexes.insert(who.key.clone(), states.len());
        states.push(MembershipState {
            position,
            first: event.clone(),
            last: event,
            who: who.clone(),
        });
    }
}

fn record_nick(chains: &mut Vec<NickChain>, position: usize, old: &Who, new: &Who) {
    if let Some(chain) = chains.iter_mut().find(|chain| chain.new.key == old.key) {
        chain.new = new.clone();
    } else {
        chains.push(NickChain {
            position,
            old: old.clone(),
            new: new.clone(),
        });
    }
}

fn append_modes(
    clauses: &mut Vec<PositionedClause>,
    position: usize,
    actor: &Actor,
    changes: &[super::ModeProjection],
) {
    if let Some(RunClause::Modes { changes: known, .. }) = clauses
        .iter_mut()
        .find(|clause| matches!(&clause.clause, RunClause::Modes { actor: known, .. } if known == actor))
        .map(|clause| &mut clause.clause)
    {
        known.extend_from_slice(changes);
    } else {
        clauses.push(PositionedClause {
            position,
            clause: RunClause::Modes {
                actor: actor.clone(),
                changes: changes.to_vec(),
            },
        });
    }
}

fn append_invited(
    clauses: &mut Vec<PositionedClause>,
    position: usize,
    actor: &Actor,
    subject: &Who,
) {
    if let Some(RunClause::Invited { people, .. }) = clauses
        .iter_mut()
        .find(|clause| matches!(&clause.clause, RunClause::Invited { actor: known, .. } if known == actor))
        .map(|clause| &mut clause.clause)
    {
        people.push(person(subject));
    } else {
        clauses.push(PositionedClause {
            position,
            clause: RunClause::Invited {
                actor: actor.clone(),
                people: vec![person(subject)],
            },
        });
    }
}

fn append_membership(clauses: &mut Vec<PositionedClause>, state: &MembershipState) {
    let person = person(&state.who);
    let clause = match (&state.first, &state.last) {
        (MembershipEvent::Join, MembershipEvent::Join) => RunClause::Joined {
            people: vec![person],
        },
        (MembershipEvent::Join, MembershipEvent::Part(_) | MembershipEvent::Quit(_)) => {
            RunClause::JoinedAndLeft {
                people: vec![person],
            }
        }
        (MembershipEvent::Part(_), MembershipEvent::Join) => RunClause::Rejoined {
            people: vec![person],
        },
        (MembershipEvent::Quit(_), MembershipEvent::Join) => RunClause::Reconnected {
            people: vec![person],
        },
        (MembershipEvent::Part(_) | MembershipEvent::Quit(_), MembershipEvent::Part(reason)) => {
            RunClause::Left {
                people: vec![Departure {
                    person,
                    reason: reason.clone(),
                }],
            }
        }
        (MembershipEvent::Part(_) | MembershipEvent::Quit(_), MembershipEvent::Quit(reason)) => {
            RunClause::Quit {
                people: vec![Departure {
                    person,
                    reason: reason.clone(),
                }],
            }
        }
    };
    if let Some(known) = clauses
        .iter_mut()
        .find(|known| same_membership_clause(&known.clause, &clause))
    {
        append_people(&mut known.clause, clause);
    } else {
        clauses.push(PositionedClause {
            position: state.position,
            clause,
        });
    }
}

fn same_membership_clause(left: &RunClause, right: &RunClause) -> bool {
    matches!(
        (left, right),
        (RunClause::Joined { .. }, RunClause::Joined { .. })
            | (
                RunClause::JoinedAndLeft { .. },
                RunClause::JoinedAndLeft { .. }
            )
            | (RunClause::Left { .. }, RunClause::Left { .. })
            | (RunClause::Quit { .. }, RunClause::Quit { .. })
            | (RunClause::Reconnected { .. }, RunClause::Reconnected { .. })
            | (RunClause::Rejoined { .. }, RunClause::Rejoined { .. })
    )
}

fn append_people(target: &mut RunClause, source: RunClause) {
    match (target, source) {
        (RunClause::Joined { people }, RunClause::Joined { people: added })
        | (RunClause::JoinedAndLeft { people }, RunClause::JoinedAndLeft { people: added })
        | (RunClause::Reconnected { people }, RunClause::Reconnected { people: added })
        | (RunClause::Rejoined { people }, RunClause::Rejoined { people: added }) => {
            people.extend(added);
        }
        (RunClause::Left { people }, RunClause::Left { people: added })
        | (RunClause::Quit { people }, RunClause::Quit { people: added }) => people.extend(added),
        _ => unreachable!("membership clause kinds match"),
    }
}

fn append_nicks(clauses: &mut Vec<PositionedClause>, chains: Vec<NickChain>) {
    let mut changes = Vec::new();
    let mut position = usize::MAX;
    for chain in chains {
        if chain.old.nick == chain.new.nick {
            continue;
        }
        position = position.min(chain.position);
        changes.push(NickChange {
            old: person(&chain.old),
            new: person(&chain.new),
        });
    }
    if !changes.is_empty() {
        clauses.push(PositionedClause {
            position,
            clause: RunClause::Nick { changes },
        });
    }
}

#[cfg(test)]
mod tests {
    use super::collapse_run;
    use crate::timeline::{
        Actor, FoldEvent, ModeMeaning, ModeProjection, OrderKey, RunClause, Who,
    };

    #[derive(Clone, Copy)]
    enum Membership {
        Join,
        Part,
        Quit,
    }

    fn who(nick: &str) -> Who {
        Who {
            nick: nick.into(),
            key: nick.to_ascii_lowercase(),
            nick_color_index: 7,
            own: false,
            msgid: Some(format!("msg-{nick}")),
        }
    }

    fn event(kind: Membership, nick: &str) -> FoldEvent {
        match kind {
            Membership::Join => FoldEvent::Joined(who(nick)),
            Membership::Part => FoldEvent::Parted(who(nick), Some("part reason".into())),
            Membership::Quit => FoldEvent::Quit(who(nick), Some("quit reason".into()), None),
        }
    }

    fn collapse(events: &[FoldEvent]) -> Vec<RunClause> {
        collapse_run(events.iter().enumerate().map(|(index, event)| {
            let time = i64::try_from(index + 1).expect("small fixture");
            (
                OrderKey::new(
                    time,
                    time,
                    u64::try_from(time).expect("positive fixture time"),
                ),
                event,
            )
        }))
        .map(|run| run.clauses().as_slice().to_vec())
        .unwrap_or_default()
    }

    #[test]
    fn membership_first_and_last_events_cover_every_table_cell() {
        let cases = [
            (Membership::Join, Membership::Join, "joined"),
            (Membership::Join, Membership::Part, "joined_and_left"),
            (Membership::Join, Membership::Quit, "joined_and_left"),
            (Membership::Part, Membership::Join, "rejoined"),
            (Membership::Part, Membership::Part, "left"),
            (Membership::Part, Membership::Quit, "quit"),
            (Membership::Quit, Membership::Join, "reconnected"),
            (Membership::Quit, Membership::Part, "left"),
            (Membership::Quit, Membership::Quit, "quit"),
        ];
        for (first, last, expected) in cases {
            let clauses = collapse(&[event(first, "Mel"), event(last, "mel")]);
            assert_eq!(clause_name(&clauses[0]), expected);
            if let RunClause::Left { people } | RunClause::Quit { people } = &clauses[0] {
                let expected_reason = if matches!(last, Membership::Part) {
                    "part reason"
                } else {
                    "quit reason"
                };
                assert_eq!(people[0].reason.as_deref(), Some(expected_reason));
            }
        }
    }

    #[test]
    fn intermediate_memberships_do_not_override_first_and_last() {
        let clauses = collapse(&[
            event(Membership::Join, "mel"),
            event(Membership::Part, "mel"),
            event(Membership::Join, "mel"),
        ]);
        assert!(matches!(&clauses[..], [RunClause::Joined { people }] if people.len() == 1));
    }

    #[test]
    fn nick_chains_collapse_and_round_trips_disappear() {
        let chained = collapse(&[
            FoldEvent::Nick {
                old: who("a"),
                new: who("b"),
            },
            FoldEvent::Nick {
                old: who("b"),
                new: who("c"),
            },
        ]);
        assert!(matches!(&chained[..], [RunClause::Nick { changes }]
            if changes[0].old.nick == "a" && changes[0].new.nick == "c"));

        let round_trip = collapse(&[
            FoldEvent::Nick {
                old: who("a"),
                new: who("b"),
            },
            FoldEvent::Nick {
                old: who("b"),
                new: who("a"),
            },
        ]);
        assert!(round_trip.is_empty());
    }

    #[test]
    fn case_only_nick_changes_remain_visible() {
        let changes = collapse(&[FoldEvent::Nick {
            old: who("alice"),
            new: who("Alice"),
        }]);

        assert!(matches!(&changes[..], [RunClause::Nick { changes }]
            if changes[0].old.nick == "alice" && changes[0].new.nick == "Alice"));
    }

    #[test]
    fn modes_and_invites_group_by_actor_at_the_first_position() {
        let actor_a = Actor::Server { name: "a".into() };
        let actor_b = Actor::Server { name: "b".into() };
        let mode = |actor: Actor, raw: &str| FoldEvent::Modes {
            actor,
            changes: vec![ModeProjection {
                added: true,
                meaning: ModeMeaning::Other,
                raw: raw.into(),
            }],
        };
        let clauses = collapse(&[
            mode(actor_a.clone(), "+a"),
            mode(actor_b.clone(), "+b"),
            mode(actor_a.clone(), "+c"),
            FoldEvent::Invited {
                actor: actor_b.clone(),
                subject: who("mel"),
            },
            FoldEvent::Invited {
                actor: actor_b,
                subject: who("rafa"),
            },
        ]);
        assert!(matches!(&clauses[..],
            [RunClause::Modes { changes: first, .. }, RunClause::Modes { changes: second, .. }, RunClause::Invited { people, .. }]
            if first.len() == 2 && second.len() == 1 && people.len() == 2));
    }

    fn clause_name(clause: &RunClause) -> &'static str {
        match clause {
            RunClause::Joined { .. } => "joined",
            RunClause::JoinedAndLeft { .. } => "joined_and_left",
            RunClause::Left { .. } => "left",
            RunClause::Quit { .. } => "quit",
            RunClause::Reconnected { .. } => "reconnected",
            RunClause::Rejoined { .. } => "rejoined",
            RunClause::Nick { .. } => "nick",
            RunClause::Modes { .. } => "modes",
            RunClause::Invited { .. } => "invited",
        }
    }
}
