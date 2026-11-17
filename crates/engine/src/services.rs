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
    state.supports(papo::Feature::EchoMessages) && is_server_service(state, nick)
}

/// Ergo's services hold no account, so papo can never prove who sent their lines; Ergo (which
/// alone advertises `SAFERATE`) reserves their nicks, which is the proof instead.
pub(crate) fn is_server_service(state: &papo::State, nick: &str) -> bool {
    state.isupport().saferate() && service_name(nick).is_some()
}

/// Ergo's own spelling of a service nick typed in any case. papo matches the nick in a WHO reply
/// exactly, and Ergo replies with its spelling, so `chanserv` would never resolve.
pub(crate) fn canonical(state: &papo::State, nick: String) -> String {
    match service_name(&nick) {
        Some(service) if sends_unlabelled(state, service) => service.to_owned(),
        _ => nick,
    }
}

fn service_name(nick: &str) -> Option<&'static str> {
    ERGO_SERVICES
        .into_iter()
        .find(|service| service.eq_ignore_ascii_case(nick))
}

#[cfg(test)]
mod tests {
    use super::service_name;

    #[test]
    fn spells_ergo_services_typed_in_any_case_as_ergo_does() {
        for (typed, service) in [
            ("ChanServ", "ChanServ"),
            ("chanserv", "ChanServ"),
            ("NICKSERV", "NickServ"),
            ("HostServ", "HostServ"),
            ("histserv", "HistServ"),
        ] {
            assert_eq!(service_name(typed), Some(service), "{typed}");
        }
    }

    #[test]
    fn leaves_people_and_lookalikes_guarded() {
        for nick in ["alice", "ChanServ_", "Chan", "OperServ", "BotServ", ""] {
            assert_eq!(service_name(nick), None, "{nick}");
        }
    }
}
