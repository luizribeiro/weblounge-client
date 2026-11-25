use super::{changed_messages, known_channel, next_matching, next_sent_containing, wire};
use crate::{
    BufferId, EngineMessageKey, MessageId, MessageProjection, NetworkId,
    runtime::{send, send_reaction, unrestricted},
    state::{NetworkModel, PendingSend},
};

const CONFIRMING_CAPS: [&str; 3] = ["echo-message", "labeled-response", "message-tags"];
/// Enough words for papo to split one send into two lines.
const SPLIT_TEXT_WORDS: usize = 120;

struct Room {
    client: papo::Client,
    events: papo::Events,
    wire: papo_testing::Wire,
    model: NetworkModel,
    buffer_id: BufferId,
}

impl Room {
    async fn joined(caps: &[&str], isupport: &[&str]) -> Self {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "weblounge"));
        wire.register(caps).await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        for line in isupport {
            wire.server(*line).await;
        }
        wire.server(":weblounge!u@host JOIN #room").await;
        _ = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
        let mut model = NetworkModel::new(NetworkId(1), "Test".into(), "weblounge".into(), 50);
        model.sync_channels(&client.snapshot());
        let buffer_id = model
            .buffer_id_for_channel(&known_channel(&client, "#room"))
            .expect("joined channel is projected");
        Self {
            client,
            events,
            wire,
            model,
            buffer_id,
        }
    }

    /// Sends through papo, answering the first `echoed` of the `lines` it writes with a labeled
    /// echo whose msgid is `s<index>` and the rest with a bare `ACK`, and confirms the send in the
    /// model.
    async fn send(&mut self, pending: PendingSend, lines: usize, echoed: usize) -> Vec<String> {
        let client = self.client.clone();
        let task = tokio::spawn(async move {
            send(&client, &pending)
                .await
                .map(|outcome| (pending, outcome))
        });
        let mut sent = Vec::with_capacity(lines);
        for index in 0..lines {
            let line = next_sent_containing(&mut self.wire, "PRIVMSG ").await;
            if let Some(answer) = labeled_answer(&line, index, index < echoed) {
                self.wire.server(answer).await;
            }
            sent.push(line);
        }
        let (pending, outcome) = task
            .await
            .expect("send task completes")
            .expect("send succeeds");
        self.model
            .confirm_send(&pending, &outcome)
            .expect("optimistic row exists");
        sent
    }

    fn row(&self, msgid: &str) -> MessageId {
        self.model
            .projected_messages(self.buffer_id)
            .into_iter()
            .find(|message| message.server_ids == [msgid])
            .expect("the confirmed line is a row")
            .id
    }

    fn reply_msgid(&mut self, parent: MessageId) -> Result<Option<String>, EngineMessageKey> {
        let state = self.client.snapshot();
        self.model
            .begin_reply(self.buffer_id, parent, "agreed".into(), &state)
            .map(|(pending, _)| pending.reply.map(|reply| reply.msgid))
    }

    fn emitted_rows(&mut self) -> Vec<MessageProjection> {
        changed_messages(&self.model.take_timeline_changes(false))
            .into_iter()
            .map(|(_, message)| message)
            .collect()
    }

    fn begin_send(&mut self, text: String) -> PendingSend {
        let state = self.client.snapshot();
        self.model
            .begin_send(self.buffer_id, text, &state)
            .expect("channel is sendable")
            .0
    }

    fn assert_unaddressable_send(&mut self) {
        let row = self
            .model
            .projected_messages(self.buffer_id)
            .into_iter()
            .find(|message| message.text == split_text())
            .expect("the send stays one row");
        assert!(row.server_ids.is_empty());
        assert_eq!(
            self.reply_msgid(row.id),
            Err(EngineMessageKey::ReplyParentGone)
        );
        assert!(
            self.model
                .toggle_own_reaction(self.buffer_id, row.id, "👍".into())
                .is_none()
        );
        assert!(
            self.model
                .begin_own_redaction(self.buffer_id, row.id)
                .is_none()
        );
    }
}

/// The server's labeled answer to one line papo wrote, or `None` when papo did not label it.
fn labeled_answer(line: &str, index: usize, echoed: bool) -> Option<String> {
    let (tags, command) = line.strip_prefix('@')?.split_once(' ')?;
    let label = tags.split(';').find_map(|tag| tag.strip_prefix("label="))?;
    if !echoed {
        return Some(format!("@label={label} :offline.test ACK"));
    }
    let (target, text) = command.strip_prefix("PRIVMSG ")?.split_once(' ')?;
    let text = text.strip_prefix(':').unwrap_or(text);
    Some(format!(
        "@label={label};msgid=s{index} :weblounge!u@host PRIVMSG {target} :{text}"
    ))
}

fn split_text() -> String {
    vec!["word"; SPLIT_TEXT_WORDS].join(" ")
}

#[tokio::test]
async fn labelled_split_send_preserves_every_msgid_without_an_echo_row() {
    let mut room = Room::joined(&CONFIRMING_CAPS, &[]).await;
    let text = "a".repeat(600);
    let pending = room.begin_send(text.clone());
    let sent = room.send(pending, 2, 2).await;

    let texts = sent
        .iter()
        .zip(["@label=0 PRIVMSG #room ", "@label=0-1 PRIVMSG #room "])
        .map(|(line, prefix)| line.strip_prefix(prefix).expect("a labelled line"))
        .collect::<Vec<_>>();
    assert_eq!(texts.concat(), text);
    let rows = room.emitted_rows();
    for (msgid, text) in ["s0", "s1"].into_iter().zip(texts) {
        assert!(
            rows.iter()
                .any(|row| row.server_ids == [msgid] && row.text == text)
        );
    }
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(10), room.events.next())
            .await
            .is_err(),
        "correlated own echoes must be consumed into Sent"
    );
}

#[tokio::test]
async fn every_confirmed_line_of_a_split_send_is_reactable_repliable_and_deletable() {
    let mut room = Room::joined(&CONFIRMING_CAPS, &[]).await;
    let pending = room.begin_send(split_text());
    room.send(pending, 2, 2).await;

    let rows = room.emitted_rows();
    for msgid in ["s0", "s1"] {
        assert!(
            rows.iter()
                .any(|row| row.server_ids == [msgid] && !row.inert)
        );
        let row = room.row(msgid);
        assert_eq!(room.reply_msgid(row), Ok(Some(msgid.to_owned())));
        assert!(
            room.model
                .toggle_own_reaction(room.buffer_id, row, "👍".into())
                .is_some()
        );
        assert!(
            room.model
                .begin_own_redaction(room.buffer_id, row)
                .is_some()
        );
    }
}

#[tokio::test]
async fn an_unconfirmed_split_send_stays_unaddressable() {
    let mut room = Room::joined(&["message-tags"], &[]).await;
    let pending = room.begin_send(split_text());
    let sent = room.send(pending, 2, 0).await;
    assert!(
        sent.iter().all(|line| line.starts_with("PRIVMSG #room ")),
        "{sent:?}"
    );
    room.assert_unaddressable_send();
}

#[tokio::test]
async fn a_split_send_with_one_unconfirmed_line_stays_unaddressable() {
    let mut room = Room::joined(&CONFIRMING_CAPS, &[]).await;
    let pending = room.begin_send(split_text());
    room.send(pending, 2, 1).await;
    room.assert_unaddressable_send();
}

#[tokio::test]
async fn a_split_reply_to_an_ops_only_line_keeps_reacting_to_the_ops() {
    let mut room = Room::joined(
        &CONFIRMING_CAPS,
        &[":offline.test 005 weblounge STATUSMSG=@+ PREFIX=(ov)@+ :are supported"],
    )
    .await;
    room.wire
        .server("@msgid=p1 :oppy!o@host PRIVMSG @#room :rotate the deploy key?")
        .await;
    let papo::Event::Message(parent) = unrestricted(
        next_matching(&mut room.events, |event| {
            matches!(event, papo::Event::Restricted(_))
        })
        .await,
    ) else {
        panic!("an ops-only line is a message");
    };
    let state = room.client.snapshot();
    room.model.receive(&parent, false, &state, None);
    let (pending, _) = room
        .model
        .begin_reply(room.buffer_id, room.row("p1"), split_text(), &state)
        .expect("the ops-only line is addressable");

    let sent = room.send(pending, 2, 2).await;
    assert!(
        sent.iter().all(|line| line.contains(" PRIVMSG @#room ")),
        "{sent:?}"
    );

    let change = room
        .model
        .toggle_own_reaction(room.buffer_id, room.row("s1"), "👍".into())
        .expect("the second line is reactable");
    let client = room.client.clone();
    let reaction = tokio::spawn(async move { send_reaction(&client, &change).await });
    let tagmsg = next_sent_containing(&mut room.wire, "TAGMSG").await;
    assert!(tagmsg.contains("reply=s1;"), "{tagmsg}");
    assert!(tagmsg.ends_with("TAGMSG @#room"), "{tagmsg}");
    reaction.abort();
}
