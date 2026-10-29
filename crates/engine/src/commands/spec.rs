#![allow(
    missing_docs,
    reason = "the protocol field names are the command metadata vocabulary"
)]

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::InputError;

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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Ord, PartialOrd)]
pub(crate) enum CompletionPriority {
    Everyday,
    #[default]
    Other,
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
    #[serde(skip)]
    #[ts(skip)]
    pub(crate) completion_priority: CompletionPriority,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub confirmation_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub confirmation_action: Option<String>,
    pub secret_arguments: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CommandRegistry {
    specs: Vec<CommandSpec>,
}

pub(crate) struct RegisteredCommand<'registry, 'input> {
    pub(crate) spec: &'registry CommandSpec,
    pub(crate) arguments: &'input str,
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

    pub(crate) fn parse<'registry, 'input>(
        &'registry self,
        input: &'input str,
    ) -> Result<RegisteredCommand<'registry, 'input>, InputError> {
        let input = input.trim_start();
        let end = input.find(char::is_whitespace).unwrap_or(input.len());
        let name = input
            .get(..end)
            .filter(|name| !name.is_empty())
            .ok_or(InputError::MissingArgument)?;
        let spec = self
            .specs
            .iter()
            .find(|spec| {
                spec.name.eq_ignore_ascii_case(name)
                    || spec
                        .aliases
                        .iter()
                        .any(|alias| alias.eq_ignore_ascii_case(name))
            })
            .ok_or_else(|| InputError::UnknownCommand(name.into()))?;
        Ok(RegisteredCommand {
            spec,
            arguments: input.get(end..).unwrap_or_default().trim_start(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{CommandPermission, CommandRegistry, CommandSpec, ConfirmPolicy};

    #[test]
    fn runtime_registry_parses_and_lists_new_specs() {
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
            completion_priority: super::CompletionPriority::Other,
            confirmation_prompt: None,
            confirmation_action: None,
            secret_arguments: false,
        };
        let mut registry = CommandRegistry::default();
        assert!(registry.register(spec.clone()));
        assert!(!registry.register(spec));
        assert_eq!(registry.specs().len(), 1);
        let parsed = registry.parse("  Later argument").expect("command parses");
        assert_eq!(parsed.spec.name, "later");
        assert_eq!(parsed.arguments, "argument");
    }
}
