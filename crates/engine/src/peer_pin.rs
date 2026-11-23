//! Who a direct-message peer is, as far as this connection can prove it.
//!
//! An account is only as trustworthy as the connection that reported it, so a pin holds one only
//! when the connection to the server is TLS; that account is what survives restarts. A pin also
//! remembers whether this connection has watched the nick's holder without a break: once that
//! holder renames away, quits or leaves every channel we share, whoever holds the nick next is
//! someone new until the user says otherwise. Every copy of a pin, such as the one a queued send
//! carries, sees that departure.

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

const STORED_PREFIX: &str = "account=";
const LEGACY_PREFIX: &str = "papo-pin:1;";

#[derive(Clone, Debug, Default)]
pub(crate) struct PeerPin {
    account: Option<String>,
    holder: Holder,
}

#[derive(Clone, Debug, Default)]
enum Holder {
    /// This connection has not tracked the nick's holder.
    #[default]
    Unseen,
    /// This connection tracked the nick's holder when the pin was made; the flag says whether
    /// that holder has since given the nick up, so a later holder is someone new.
    Tracked { left: Arc<AtomicBool> },
}

impl Holder {
    fn tracked() -> Self {
        Self::Tracked {
            left: Arc::new(AtomicBool::new(false)),
        }
    }

    fn has_left(&self) -> bool {
        matches!(self, Self::Tracked { left } if left.load(Ordering::Relaxed))
    }
}

#[derive(Clone, Debug)]
pub(crate) enum PinCheck {
    Match,
    Upgrade(PeerPin),
    Mismatch(PinMismatch),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PinMismatch {
    /// Both sides name accounts, and they differ.
    DifferentAccount,
    /// One side lacks the proof the other has, or the pinned holder gave the nick up.
    CannotVerify,
}

impl PeerPin {
    /// The identity a line from `nick` proves, given the account the server put on it; `None`
    /// when it proves nothing.
    pub(crate) fn observed(
        state: &papo::State,
        nick: &papo::Nick,
        account: &papo::AccountStatus,
        tls: bool,
    ) -> Option<Self> {
        let pin = Self {
            account: tls.then(|| account_key(state, account)).flatten(),
            holder: holder(state, nick),
        };
        pin.is_known().then_some(pin)
    }

    /// What papo knows about whoever holds `nick` now.
    pub(crate) fn of_holder(state: &papo::State, nick: &papo::Nick, tls: bool) -> Self {
        let account = crate::name_key::known_user(state, nick)
            .map_or(&papo::AccountStatus::Unknown, papo::User::account);
        Self {
            account: tls.then(|| account_key(state, account)).flatten(),
            holder: holder(state, nick),
        }
    }

    /// Restores a pin stored by [`Self::stored`], or one papo stored before weblounge kept its
    /// own; whatever cannot be read is treated as a peer never verified.
    pub(crate) fn restore(stored: &str) -> Option<Self> {
        let account = stored
            .strip_prefix(STORED_PREFIX)
            .map(str::to_owned)
            .or_else(|| legacy_account(stored))
            .filter(|account| !account.is_empty())?;
        Some(Self {
            account: Some(account),
            holder: Holder::Unseen,
        })
    }

    /// The durable part of the pin, for the chat-list snapshot.
    pub(crate) fn stored(&self) -> Option<String> {
        self.account
            .as_ref()
            .map(|account| format!("{STORED_PREFIX}{account}"))
    }

    pub(crate) const fn is_verified(&self) -> bool {
        self.account.is_some()
    }

    pub(crate) const fn is_known(&self) -> bool {
        self.account.is_some() || matches!(self.holder, Holder::Tracked { .. })
    }

    /// Drops what only this connection could vouch for; `false` when nothing durable remains.
    pub(crate) fn forget_connection(&mut self) -> bool {
        self.holder = Holder::Unseen;
        self.account.is_some()
    }

    pub(crate) fn holder_left(&self) {
        if let Holder::Tracked { left } = &self.holder {
            left.store(true, Ordering::Relaxed);
        }
    }

    pub(crate) fn check(&self, current: &Self) -> PinCheck {
        match (&self.account, &current.account) {
            (Some(stored), Some(current)) if stored == current => PinCheck::Match,
            (Some(_), Some(_)) => PinCheck::Mismatch(PinMismatch::DifferentAccount),
            (Some(_), None) => PinCheck::Mismatch(PinMismatch::CannotVerify),
            (None, _) if self.holder.has_left() => PinCheck::Mismatch(PinMismatch::CannotVerify),
            (None, None) if matches!(self.holder, Holder::Tracked { .. }) => PinCheck::Match,
            (None, _) => PinCheck::Upgrade(current.clone()),
        }
    }

    /// Whether a line sent to `nick` now would reach this pin's peer, judged by what papo knows
    /// about the nick's holder. A holder papo knows nothing about is no evidence against it.
    pub(crate) fn check_recipient(
        &self,
        state: &papo::State,
        nick: &papo::Nick,
        tls: bool,
    ) -> Result<(), PinMismatch> {
        let holder = crate::name_key::known_user(state, nick);
        if let Some(stored) = &self.account {
            return match holder.map(papo::User::account) {
                Some(account @ papo::AccountStatus::LoggedIn(_)) if tls => {
                    if account_key(state, account).as_ref() == Some(stored) {
                        Ok(())
                    } else {
                        Err(PinMismatch::DifferentAccount)
                    }
                }
                Some(papo::AccountStatus::LoggedOut | papo::AccountStatus::LoggedIn(_)) => {
                    Err(PinMismatch::CannotVerify)
                }
                _ => Ok(()),
            };
        }
        if self.holder.has_left() && holder.is_some() {
            Err(PinMismatch::CannotVerify)
        } else {
            Ok(())
        }
    }
}

/// The DM peers whose nick this event shows its holder giving up: a rename away, a quit, or a
/// part or kick that leaves papo tracking nobody under the nick.
pub(crate) fn departures(event: &papo::Event, state: &papo::State) -> Vec<papo::Nick> {
    let untracked = |nick: papo::Nick| {
        crate::name_key::known_user(state, &nick)
            .is_none()
            .then_some(nick)
    };
    match event {
        papo::Event::NickChanged(changed) if changed.actor_party != papo::Party::Me => {
            vec![changed.old.clone()]
        }
        papo::Event::Quit(quit) if quit.actor_party != papo::Party::Me => {
            vec![quit.actor.nick()]
        }
        papo::Event::Parted(parted) if parted.actor_party != papo::Party::Me => {
            untracked(parted.actor.nick()).into_iter().collect()
        }
        papo::Event::Kicked(kicked) if kicked.subject_party != papo::Party::Me => {
            untracked(kicked.subject.nick()).into_iter().collect()
        }
        _ => Vec::new(),
    }
}

fn holder(state: &papo::State, nick: &papo::Nick) -> Holder {
    if crate::name_key::known_user(state, nick).is_some() {
        Holder::tracked()
    } else {
        Holder::Unseen
    }
}

fn account_key(state: &papo::State, account: &papo::AccountStatus) -> Option<String> {
    let name = account.name()?;
    let rules = state.name_rules()?;
    Some(rules.account(name.as_str()).key().to_owned())
}

/// papo's own pins named the account as `account=<percent-escaped name>` among other fields.
fn legacy_account(stored: &str) -> Option<String> {
    stored
        .strip_prefix(LEGACY_PREFIX)?
        .split(';')
        .find_map(|field| field.strip_prefix(STORED_PREFIX))
        .and_then(percent_decode)
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = value
                .get(index + 1..index + 3)
                .filter(|hex| hex.bytes().all(|byte| byte.is_ascii_hexdigit()))?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

#[cfg(test)]
mod tests {
    use super::{Holder, PeerPin, PinCheck, PinMismatch};

    fn account(name: &str) -> PeerPin {
        PeerPin {
            account: Some(name.to_owned()),
            holder: Holder::Unseen,
        }
    }

    fn tracked() -> PeerPin {
        PeerPin {
            account: None,
            holder: Holder::tracked(),
        }
    }

    #[test]
    fn the_same_account_matches_and_another_is_a_different_account() {
        assert!(matches!(
            account("alice").check(&account("alice")),
            PinCheck::Match
        ));
        assert!(matches!(
            account("alice").check(&account("mallory")),
            PinCheck::Mismatch(PinMismatch::DifferentAccount)
        ));
    }

    #[test]
    fn an_account_pin_cannot_verify_a_peer_that_proves_none() {
        assert!(matches!(
            account("alice").check(&tracked()),
            PinCheck::Mismatch(PinMismatch::CannotVerify)
        ));
    }

    #[test]
    fn a_held_nick_matches_until_its_holder_gives_it_up() {
        let pin = tracked();
        let queued = pin.clone();
        assert!(matches!(pin.check(&tracked()), PinCheck::Match));

        pin.holder_left();

        for pin in [pin, queued] {
            assert!(matches!(
                pin.check(&tracked()),
                PinCheck::Mismatch(PinMismatch::CannotVerify)
            ));
        }
    }

    #[test]
    fn a_held_nick_takes_the_account_it_later_proves() {
        assert!(matches!(
            tracked().check(&account("alice")),
            PinCheck::Upgrade(pin) if pin.stored().as_deref() == Some("account=alice")
        ));
    }

    #[test]
    fn a_new_connection_keeps_only_the_account() {
        let mut held = tracked();
        assert!(!held.forget_connection());

        let mut pinned = account("alice");
        pinned.holder = Holder::tracked();
        pinned.holder_left();
        assert!(pinned.forget_connection());
        assert!(matches!(pinned.check(&account("alice")), PinCheck::Match));
    }

    #[test]
    fn stored_pins_round_trip_and_read_papos_former_format() {
        let restored = PeerPin::restore("account=alice").expect("stored pin");
        assert_eq!(restored.stored().as_deref(), Some("account=alice"));

        let legacy =
            PeerPin::restore("papo-pin:1;server=irc.example;casemap=rfc1459;account=al%3Bice")
                .expect("papo pin");
        assert_eq!(legacy.stored().as_deref(), Some("account=al;ice"));
    }

    #[test]
    fn unreadable_stored_pins_are_treated_as_never_verified() {
        for stored in [
            "",
            "account=",
            "papo-pin:1;server=irc.example",
            "papo-pin:1;account=%zz",
            "papo-pin:1;account=%+f",
        ] {
            assert!(PeerPin::restore(stored).is_none(), "{stored}");
        }
    }
}
