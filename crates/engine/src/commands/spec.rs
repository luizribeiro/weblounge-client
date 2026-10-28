#![allow(
    missing_docs,
    reason = "the protocol field names are the command metadata vocabulary"
)]

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CommandArgumentKind {
    Nick,
    Channel,
    ChannelList,
    KeyList,
    Target,
    Text,
    CommandName,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct CommandArgumentSpec {
    pub name: String,
    pub kind: CommandArgumentKind,
    pub required: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum CommandRequirement {
    Connected,
    Feature(String),
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CommandPermission {
    Anyone,
    HalfOp,
    Op,
    Oper,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum CommandSurface {
    Slash,
    Palette,
    UserMenu,
    MessageMenu,
    ChannelMenu,
    NetworkMenu,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ConfirmPolicy {
    None,
    Menu,
    Always,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct CommandSpec {
    pub name: String,
    pub aliases: Vec<String>,
    pub arguments: Vec<CommandArgumentSpec>,
    pub usage: String,
    pub description: String,
    pub requirements: Vec<CommandRequirement>,
    pub permission: CommandPermission,
    pub surfaces: Vec<CommandSurface>,
    pub confirm: ConfirmPolicy,
    pub secret_arguments: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CommandRegistry {
    specs: Vec<CommandSpec>,
}

impl CommandRegistry {
    #[must_use]
    pub fn new(specs: Vec<CommandSpec>) -> Self {
        Self { specs }
    }

    pub fn register(&mut self, spec: CommandSpec) -> bool {
        if self.specs.iter().any(|current| {
            current.name == spec.name
                || current.aliases.contains(&spec.name)
                || spec.aliases.contains(&current.name)
                || current
                    .aliases
                    .iter()
                    .any(|alias| spec.aliases.contains(alias))
        }) {
            return false;
        }
        self.specs.push(spec);
        true
    }

    #[must_use]
    pub fn specs(&self) -> &[CommandSpec] {
        &self.specs
    }
}

#[cfg(test)]
mod tests {
    use super::{CommandPermission, CommandRegistry, CommandSpec, ConfirmPolicy};

    #[test]
    fn runtime_registry_accepts_new_unique_specs() {
        let spec = CommandSpec {
            name: "later".into(),
            aliases: vec!["l".into()],
            arguments: Vec::new(),
            usage: "cmd.later.usage".into(),
            description: "cmd.later.description".into(),
            requirements: Vec::new(),
            permission: CommandPermission::Anyone,
            surfaces: Vec::new(),
            confirm: ConfirmPolicy::None,
            secret_arguments: false,
        };
        let mut registry = CommandRegistry::default();
        assert!(registry.register(spec.clone()));
        assert!(!registry.register(spec));
        assert_eq!(registry.specs().len(), 1);
    }
}
