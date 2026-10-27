//! Platform-neutral weblounge engine composition.

mod direct_target;
mod name_key;
mod protocol;
mod runtime;
mod state;

use tokio::sync::mpsc;

pub use protocol::{
    BufferId, BufferKind, BufferProjection, Command, CommandEnvelope, EngineToUi, Hello,
    LocalSendId, MessageAuthorship, MessageDelivery, MessageId, MessageProjection,
    NetworkConnectionState, NetworkId, NetworkProjection, SaslCredentials, ShellKind, UiToEngine,
};

/// The product engine owned by a platform host.
pub struct Engine {
    build_id: String,
    instance_id: String,
    runtime: runtime::Runtime,
}

impl Engine {
    /// Creates an engine for one application build and host lifetime.
    #[must_use]
    pub fn new(build_id: impl Into<String>, instance_id: impl Into<String>) -> Self {
        let (outbound, _events) = mpsc::unbounded_channel();
        Self::with_sender(build_id, instance_id, outbound)
    }

    /// Creates an engine and a receiver for asynchronous protocol events.
    pub fn with_events(
        build_id: impl Into<String>,
        instance_id: impl Into<String>,
    ) -> (Self, mpsc::UnboundedReceiver<EngineToUi>) {
        let (outbound, events) = mpsc::unbounded_channel();
        (Self::with_sender(build_id, instance_id, outbound), events)
    }

    fn with_sender(
        build_id: impl Into<String>,
        instance_id: impl Into<String>,
        outbound: mpsc::UnboundedSender<EngineToUi>,
    ) -> Self {
        Self {
            build_id: build_id.into(),
            instance_id: instance_id.into(),
            runtime: runtime::Runtime::new(outbound),
        }
    }

    /// Handles one typed UI message and returns ordered engine events.
    #[must_use]
    pub fn handle(&self, message: UiToEngine) -> Vec<EngineToUi> {
        match message {
            UiToEngine::Hello(hello) => self.hello(hello),
            UiToEngine::Command(envelope) => self.runtime.command(envelope),
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
