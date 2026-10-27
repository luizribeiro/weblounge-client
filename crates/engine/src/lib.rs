//! Platform-neutral weblounge engine composition.

mod protocol;

pub use protocol::{Command, CommandEnvelope, EngineToUi, Hello, ShellKind, UiToEngine};

/// The product engine owned by a platform host.
pub struct Engine {
    build_id: String,
    instance_id: String,
}

impl Engine {
    /// Creates an engine for one application build and host lifetime.
    #[must_use]
    pub fn new(build_id: impl Into<String>, instance_id: impl Into<String>) -> Self {
        Self {
            build_id: build_id.into(),
            instance_id: instance_id.into(),
        }
    }

    /// Handles one typed UI message and returns ordered engine events.
    #[must_use]
    pub fn handle(&self, message: UiToEngine) -> Vec<EngineToUi> {
        match message {
            UiToEngine::Hello(hello) => self.hello(hello),
            UiToEngine::Command(envelope) => Self::command(envelope),
        }
    }

    fn hello(&self, hello: Hello) -> Vec<EngineToUi> {
        if hello.build_id == self.build_id {
            vec![EngineToUi::Ready {
                engine_instance: self.instance_id.clone(),
                revision: 0,
            }]
        } else {
            vec![EngineToUi::IncompatibleBuild {
                engine: self.build_id.clone(),
                ui: hello.build_id,
            }]
        }
    }

    fn command(envelope: CommandEnvelope) -> Vec<EngineToUi> {
        match envelope.command {
            Command::Diagnostic { message } => vec![
                EngineToUi::Diagnostic {
                    command_id: envelope.id.clone(),
                    message,
                },
                EngineToUi::CommandResult { id: envelope.id },
            ],
        }
    }
}

/// Creates a papo client builder for a weblounge connection.
pub fn client_builder(endpoint: &str, nickname: &str) -> papo::Builder {
    papo::Client::builder(endpoint, nickname)
}

#[cfg(test)]
mod tests {
    use papo_testing::wire;

    use crate::{Command, CommandEnvelope, Engine, EngineToUi, Hello, ShellKind, UiToEngine};

    #[tokio::test]
    async fn client_builder_registers_with_papo() {
        let (_client, mut events, mut wire) =
            wire(super::client_builder("irc://offline.test", "weblounge"));

        wire.register(&[]).await;

        loop {
            match events.next().await {
                Some(papo::Event::Connected(connected)) => {
                    assert_eq!(connected.welcome, "Welcome to the ErgoTest IRC Network");
                    break;
                }
                Some(_) => {}
                None => panic!("papo stopped before registration completed"),
            }
        }
    }

    #[test]
    fn handshake_rejects_a_stale_ui_build() {
        let engine = Engine::new("current", "engine-1");

        assert_eq!(
            engine.handle(UiToEngine::Hello(Hello {
                build_id: "stale".into(),
                client_id: "tab-1".into(),
                last_revision: None,
                shell: ShellKind::Web,
            })),
            [EngineToUi::IncompatibleBuild {
                engine: "current".into(),
                ui: "stale".into(),
            }]
        );
    }

    #[test]
    fn diagnostic_command_emits_an_event_then_a_result() {
        let engine = Engine::new("build", "engine-1");

        assert_eq!(
            engine.handle(UiToEngine::Command(CommandEnvelope {
                id: "command-1".into(),
                command: Command::Diagnostic {
                    message: "worker alive".into(),
                },
            })),
            [
                EngineToUi::Diagnostic {
                    command_id: "command-1".into(),
                    message: "worker alive".into(),
                },
                EngineToUi::CommandResult {
                    id: "command-1".into(),
                },
            ]
        );
    }
}
