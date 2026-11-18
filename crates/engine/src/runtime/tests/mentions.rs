use super::{EngineToUi, changed_messages, collect, harness, next_matching, process_event, wire};
use crate::{MessageProjection, timeline::Person};

struct Room {
    client: papo::Client,
    events: papo::Events,
    wire: papo_testing::Wire,
    state: std::sync::Arc<std::sync::Mutex<super::RuntimeState>>,
    outbound: tokio::sync::mpsc::UnboundedSender<EngineToUi>,
    receiver: tokio::sync::mpsc::UnboundedReceiver<EngineToUi>,
    projected: Vec<MessageProjection>,
}

impl Room {
    async fn joined(names: &str) -> Self {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge").autojoin(["#lounge"]));
        wire.register(&["message-tags", "server-time"]).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        assert!(wire.next_sent().await.ends_with("JOIN #lounge"));
        let (state, outbound, receiver) = harness(client.clone());
        let mut room = Self {
            client,
            events,
            wire,
            state,
            outbound,
            receiver,
            projected: Vec::new(),
        };
        room.deliver(":weblounge!u@host JOIN #lounge", |event| {
            matches!(event, papo::Event::Joined(_))
        })
        .await;
        room.wire
            .server(&format!(":offline.test 353 weblounge = #lounge :{names}"))
            .await;
        room.deliver(
            ":offline.test 366 weblounge #lounge :End of NAMES",
            |event| matches!(event, papo::Event::ChannelSynced(_)),
        )
        .await;
        _ = collect(&mut room.receiver);
        room
    }

    async fn deliver(&mut self, line: &str, wanted: impl Fn(&papo::Event) -> bool) {
        self.wire.server(line).await;
        let event = next_matching(&mut self.events, wanted).await;
        process_event(&self.state, &self.outbound, &self.client, 1, event);
    }

    async fn say(&mut self, line: &str) {
        self.deliver(line, |event| matches!(event, papo::Event::Message(_)))
            .await;
    }

    fn latest(&mut self, text: &str) -> MessageProjection {
        self.projected.extend(
            changed_messages(&collect(&mut self.receiver))
                .into_iter()
                .map(|(_, message)| message),
        );
        self.projected
            .iter()
            .rev()
            .find(|message| message.text == text)
            .cloned()
            .expect("the message is projected")
    }
}

fn mentioned(nick: &str, me: bool) -> Person {
    Person {
        nick: nick.to_owned(),
        nick_color_index: crate::state::nick_color_index(papo::Casemapping::Rfc1459, nick),
        me,
    }
}

#[tokio::test]
async fn a_member_who_never_spoke_is_mentioned() {
    let mut room = Room::joined("weblounge sheki @luiz").await;

    room.say(":luiz!l@host PRIVMSG #lounge :sheki: are you still alive?")
        .await;
    room.say(":luiz!l@host PRIVMSG #lounge :ping Sheki, weblounge and nobody")
        .await;

    assert_eq!(
        room.latest("sheki: are you still alive?").mentions,
        Some(vec![mentioned("sheki", false)])
    );
    assert_eq!(
        room.latest("ping Sheki, weblounge and nobody").mentions,
        Some(vec![
            mentioned("Sheki", false),
            mentioned("weblounge", true)
        ])
    );
}

#[tokio::test]
async fn a_mention_stays_after_the_member_leaves() {
    let mut room = Room::joined("weblounge sheki luiz").await;
    room.say(":luiz!l@host PRIVMSG #lounge :sheki: are you still alive?")
        .await;
    _ = room.latest("sheki: are you still alive?");

    room.deliver(":sheki!s@host PART #lounge :bye", |event| {
        matches!(event, papo::Event::Parted(_))
    })
    .await;
    room.say(":luiz!l@host PRIVMSG #lounge :sheki left").await;

    assert_eq!(
        room.latest("sheki: are you still alive?").mentions,
        Some(vec![mentioned("sheki", false)])
    );
    assert_eq!(
        room.latest("sheki left").mentions,
        Some(vec![mentioned("sheki", false)])
    );
}

#[tokio::test]
async fn a_nick_learned_later_colours_earlier_mentions() {
    let mut room = Room::joined("weblounge luiz").await;
    room.say(":luiz!l@host PRIVMSG #lounge :sheki: are you still alive?")
        .await;
    assert_eq!(room.latest("sheki: are you still alive?").mentions, None);

    room.deliver(":sheki!s@host JOIN #lounge", |event| {
        matches!(event, papo::Event::Joined(_))
    })
    .await;

    assert_eq!(
        room.latest("sheki: are you still alive?").mentions,
        Some(vec![mentioned("sheki", false)])
    );
}
