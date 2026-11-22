use super::{collect, harness, lock, process_event, wire};
use crate::{
    EngineToUi,
    timeline::{ItemBody, LineEvent, SystemLine},
};

struct Session {
    client: papo::Client,
    events: papo::Events,
    wire: papo_testing::Wire,
    state: std::sync::Arc<std::sync::Mutex<super::RuntimeState>>,
    outbound: tokio::sync::mpsc::UnboundedSender<EngineToUi>,
    receiver: tokio::sync::mpsc::UnboundedReceiver<EngineToUi>,
}

impl Session {
    fn new() -> Self {
        let (client, events, wire) = wire(papo::Client::builder("irc://offline.test", "luiz"));
        let (state, outbound, receiver) = harness(client.clone());
        Self {
            client,
            events,
            wire,
            state,
            outbound,
            receiver,
        }
    }

    async fn register(&mut self, motd: &[&str]) {
        assert_eq!(self.wire.next_sent().await, "CAP LS 302");
        assert_eq!(self.wire.next_sent().await, "NICK luiz");
        assert!(self.wire.next_sent().await.starts_with("USER "));
        self.wire.server(":offline.test CAP * LS :").await;
        assert_eq!(self.wire.next_sent().await, "CAP END");
        self.wire
            .server(":irc.weblounge.org 001 luiz :Welcome to weblounge")
            .await;
        if motd.is_empty() {
            self.wire
                .server(":irc.weblounge.org 422 luiz :MOTD File is missing")
                .await;
        } else {
            self.wire
                .server(":irc.weblounge.org 375 luiz :- irc.weblounge.org Message of the day - ")
                .await;
            for line in motd {
                self.wire
                    .server(format!(":irc.weblounge.org 372 luiz :{line}"))
                    .await;
            }
            self.wire
                .server(":irc.weblounge.org 376 luiz :End of MOTD command")
                .await;
        }
        self.process_until_connected().await;
    }

    async fn process_until_connected(&mut self) {
        loop {
            let event = self.events.next().await.expect("papo events stay open");
            let connected = matches!(event, papo::Event::Connected(_));
            process_event(&self.state, &self.outbound, &self.client, 1, event);
            if connected {
                break;
            }
        }
        _ = collect(&mut self.receiver);
    }

    async fn reconnect(&mut self, motd: &[&str]) {
        self.wire.close().await;
        self.client
            .reconnect()
            .await
            .expect("manual reconnect starts");
        self.register(motd).await;
    }

    fn server_lines(&self) -> Vec<LineEvent> {
        let mut state = lock(&self.state);
        let model = &mut state
            .network
            .as_mut()
            .expect("network remains active")
            .model;
        let server = model.server_buffer_id();
        model
            .take_timeline_changes(true)
            .into_iter()
            .filter_map(|event| match event {
                EngineToUi::TimelineChanged {
                    buffer_id,
                    upserted,
                    ..
                } if buffer_id == server => Some(upserted),
                _ => None,
            })
            .flatten()
            .filter_map(|item| match item.body {
                ItemBody::System(system) => match system.line {
                    SystemLine::Event { event } => Some(event),
                    SystemLine::Run { .. } => None,
                },
                _ => None,
            })
            .collect()
    }
}

fn connected() -> LineEvent {
    LineEvent::Connected {
        server: "irc.example.org".into(),
        secure: true,
    }
}

#[tokio::test]
async fn connecting_shows_the_connection_in_the_server_buffer() {
    let mut session = Session::new();
    session.register(&[]).await;

    assert_eq!(session.server_lines(), [connected()]);
}

#[tokio::test]
async fn each_reconnect_adds_another_connection_line() {
    let mut session = Session::new();
    session.register(&[]).await;
    session.reconnect(&[]).await;

    assert_eq!(session.server_lines(), [connected(), connected()]);
}

#[tokio::test]
async fn the_message_of_the_day_precedes_the_connection_line() {
    let motd = ["pull up a chair.", "", "be kind, ship things."];
    let mut session = Session::new();
    session.register(&motd).await;

    assert_eq!(
        session.server_lines(),
        [
            LineEvent::Motd {
                lines: motd.map(String::from).to_vec(),
            },
            connected(),
        ]
    );
}

#[tokio::test]
async fn each_reconnect_shows_that_connection_s_message_of_the_day() {
    let motd = LineEvent::Motd {
        lines: vec!["be kind, ship things.".into()],
    };
    let mut session = Session::new();
    session.register(&["be kind, ship things."]).await;
    session.reconnect(&["be kind, ship things."]).await;

    assert_eq!(
        session.server_lines(),
        [motd.clone(), connected(), motd, connected()]
    );
}

#[test]
fn the_connection_line_names_the_endpoint_host_and_its_transport() {
    let line = |server: &str, secure| {
        Some(LineEvent::Connected {
            server: server.into(),
            secure,
        })
    };
    for (endpoint, expected) in [
        (
            "wss://irc.weblounge.org/socket",
            line("irc.weblounge.org", true),
        ),
        ("ws://127.0.0.1:4173/socket", line("127.0.0.1", false)),
        ("ircs://irc.libera.chat:6697", line("irc.libera.chat", true)),
        ("irc://irc.libera.chat", line("irc.libera.chat", false)),
        ("not an endpoint", None),
    ] {
        assert_eq!(
            super::super::connected_line(endpoint),
            expected,
            "{endpoint}"
        );
    }
}
