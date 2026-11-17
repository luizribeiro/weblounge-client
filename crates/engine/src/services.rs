//! Ergo answers a labelled `PRIVMSG` to one of its services inside that line's labeled-response
//! batch, and papo keeps every line of a sent message's batch out of the event stream, so the
//! service's reply would never reach a timeline. An unlabelled line lets the reply and the echo
//! arrive as ordinary events. Ergo reserves its service nicks, so no user can hold them there;
//! `SAFERATE` is an ISUPPORT token only Ergo advertises, so elsewhere those nicks stay guarded.

use crate::EngineMessageKey;

const ERGO_SERVICES: [&str; 4] = ["ChanServ", "NickServ", "HostServ", "HistServ"];

/// Takes `text` as an unlabelled line when it is for one of Ergo's services. Without
/// `echo-message` the line could not be shown, so the guarded send keeps it.
pub(crate) fn take_unlabelled(
    state: &papo::State,
    nick: &papo::Nick,
    text: &mut Option<String>,
) -> Option<papo::Line> {
    text.take_if(|_| sends_unlabelled(state, nick.as_str()))
        .map(|text| papo::Line::privmsg(nick.as_str(), text))
}

/// Sends the line `take_unlabelled` took, if any; otherwise the guarded send already decided
/// `guarded`.
pub(crate) async fn send(
    client: &papo::Client,
    line: Option<papo::Line>,
    guarded: Option<EngineMessageKey>,
) -> Option<EngineMessageKey> {
    let Some(line) = line else {
        return guarded;
    };
    client
        .send_raw(line)
        .await
        .err()
        .map(|_| EngineMessageKey::CommandRefused)
}

pub(crate) fn sends_unlabelled(state: &papo::State, nick: &str) -> bool {
    state.isupport().saferate() && state.supports(papo::Feature::EchoMessages) && is_service(nick)
}

fn is_service(nick: &str) -> bool {
    ERGO_SERVICES
        .iter()
        .any(|service| service.eq_ignore_ascii_case(nick))
}

#[cfg(test)]
mod tests {
    use super::is_service;

    #[test]
    fn recognises_ergo_services_in_any_case() {
        for nick in ["ChanServ", "chanserv", "NICKSERV", "HostServ", "histserv"] {
            assert!(is_service(nick), "{nick}");
        }
    }

    #[test]
    fn leaves_people_and_lookalikes_guarded() {
        for nick in ["alice", "ChanServ_", "Chan", "OperServ", "BotServ", ""] {
            assert!(!is_service(nick), "{nick}");
        }
    }
}
