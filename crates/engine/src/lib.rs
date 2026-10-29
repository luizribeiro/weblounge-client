//! Platform-neutral weblounge engine composition.

/// Runtime slash-command metadata and registration.
pub mod commands;
mod members;
mod name_key;
mod protocol;
mod runtime;
mod state;

use tokio::sync::mpsc;

pub use protocol::{
    BufferId, BufferKind, BufferProjection, CompletionCandidate, CompletionTrigger, EngineRequest,
    EngineRequestEnvelope, EngineToUi, Hello, LocalSendId, MemberGroup, MemberProjection,
    MembershipKind, MembershipProjection, MessageAuthorship, MessageDelivery, MessageId,
    MessageKind, MessageProjection, NetworkConnectionState, NetworkId, NetworkProjection,
    SaslCredentials, ShellKind, UiToEngine,
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
            UiToEngine::Request(envelope) => self.runtime.request(envelope),
        }
    }

    fn hello(&self, hello: Hello) -> Vec<EngineToUi> {
        if hello.build_id == self.build_id {
            vec![
                EngineToUi::Ready {
                    engine_instance: self.instance_id.clone(),
                    revision: 0,
                },
                EngineToUi::CommandSpecsChanged {
                    specs: commands::registry().specs().to_vec(),
                },
            ]
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

    use crate::{
        Engine, EngineRequest, EngineRequestEnvelope, EngineToUi, Hello, ShellKind, UiToEngine,
    };

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
    fn handshake_delivers_the_runtime_command_registry() {
        let engine = Engine::new("current", "engine-1");
        let output = engine.handle(UiToEngine::Hello(Hello {
            build_id: "current".into(),
            client_id: "tab-1".into(),
            last_revision: None,
            shell: ShellKind::Web,
        }));

        assert!(matches!(
            output.as_slice(),
            [EngineToUi::Ready { .. }, EngineToUi::CommandSpecsChanged { specs }]
                if specs.iter().any(|spec| spec.name == "help")
        ));
    }

    #[test]
    fn diagnostic_command_emits_an_event_then_a_result() {
        let engine = Engine::new("build", "engine-1");

        assert_eq!(
            engine.handle(UiToEngine::Request(EngineRequestEnvelope {
                id: "command-1".into(),
                request: EngineRequest::Diagnostic {
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

    #[test]
    fn submit_input_surfaces_typed_parse_errors() {
        let engine = Engine::new("build", "engine-1");
        assert_eq!(
            engine.handle(UiToEngine::Request(EngineRequestEnvelope {
                id: "bad-command".into(),
                request: EngineRequest::SubmitInput {
                    buffer_id: crate::BufferId(1),
                    input: "/whois mel".into(),
                },
            })),
            [EngineToUi::CommandRejected {
                id: "bad-command".into(),
                message_key: "composer.unknown_command".into(),
            }]
        );
    }
}
