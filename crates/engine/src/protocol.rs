use serde::{Deserialize, Serialize};

/// Initial UI identity and revision state.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct Hello {
    /// Content-derived application build identifier.
    pub build_id: String,
    /// Identity of this UI client.
    pub client_id: String,
    /// Last revision observed by the UI, when any.
    pub last_revision: Option<u64>,
    /// UI shell initiating the connection.
    pub shell: ShellKind,
}

/// UI shell variants supported by the engine protocol.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellKind {
    /// Browser shell.
    Web,
}

/// One command with its correlation identifier.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct CommandEnvelope {
    /// Command correlation identifier.
    pub id: String,
    /// Requested operation.
    pub command: Command,
}

/// Commands implemented by the current vertical slice.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    /// Round-trip diagnostic proving the worker boundary.
    Diagnostic {
        /// Opaque non-secret diagnostic text.
        message: String,
    },
}

/// Messages accepted from a UI client.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum UiToEngine {
    /// Begin or resume a UI subscription.
    Hello(Hello),
    /// Execute a command.
    Command(CommandEnvelope),
}

/// Events emitted to a UI client.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineToUi {
    /// The worker engine accepted the UI build.
    Ready {
        /// Identity stable for the worker engine lifetime.
        engine_instance: String,
        /// Current engine projection revision.
        revision: u64,
    },
    /// UI and worker assets were built from different content.
    IncompatibleBuild {
        /// Worker build identifier.
        engine: String,
        /// UI build identifier.
        ui: String,
    },
    /// Diagnostic event produced by the test command.
    Diagnostic {
        /// Command that produced this event.
        command_id: String,
        /// Diagnostic text.
        message: String,
    },
    /// Stable user-facing notice emitted by an engine adapter.
    Notice {
        /// Localization key interpreted by the UI shell.
        message_key: String,
    },
    /// Successful command acknowledgement.
    CommandResult {
        /// Completed command identifier.
        id: String,
    },
}

#[cfg(test)]
mod tests {
    use super::{EngineToUi, Hello, ShellKind, UiToEngine};

    #[test]
    fn hello_json_is_stable() {
        let message = UiToEngine::Hello(Hello {
            build_id: "build-1".into(),
            client_id: "tab-1".into(),
            last_revision: Some(7),
            shell: ShellKind::Web,
        });

        assert_eq!(
            serde_json::to_string(&message).expect("hello serializes"),
            r#"{"type":"hello","payload":{"build_id":"build-1","client_id":"tab-1","last_revision":7,"shell":"web"}}"#
        );
    }

    #[test]
    fn engine_event_round_trips() {
        let event = EngineToUi::Ready {
            engine_instance: "engine-1".into(),
            revision: 0,
        };
        let json = serde_json::to_string(&event).expect("event serializes");

        assert_eq!(
            serde_json::from_str::<EngineToUi>(&json).expect("event deserializes"),
            event
        );
    }
}
