use std::collections::HashSet;

use syn::{Expr, ExprArray, Lit, LitStr};

pub(crate) struct Metadata {
    pub(crate) name: String,
    pub(crate) aliases: Vec<String>,
    pub(crate) usage: String,
    pub(crate) description: String,
    pub(crate) requirements: Vec<String>,
    pub(crate) permission: String,
    pub(crate) surfaces: Vec<String>,
    pub(crate) completion: String,
    pub(crate) confirm: String,
    pub(crate) secret: bool,
}

impl Metadata {
    pub(crate) fn parse(variant: &syn::Variant) -> syn::Result<Self> {
        let mut result = Self {
            name: String::new(),
            aliases: Vec::new(),
            usage: String::new(),
            description: String::new(),
            requirements: vec!["Connected".into()],
            permission: "Anyone".into(),
            surfaces: Vec::new(),
            completion: "Other".into(),
            confirm: "None".into(),
            secret: false,
        };
        let attribute = variant
            .attrs
            .iter()
            .find(|attribute| attribute.path().is_ident("command"))
            .ok_or_else(|| syn::Error::new_spanned(variant, "missing command attribute"))?;
        let mut seen = HashSet::new();
        attribute.parse_nested_meta(|meta| {
            let key = meta
                .path
                .get_ident()
                .map(ToString::to_string)
                .unwrap_or_default();
            if !seen.insert(key.clone()) {
                return Err(meta.error(format!("duplicate command attribute `{key}`")));
            }
            if meta.path.is_ident("secret") {
                result.secret = true;
                return Ok(());
            }
            match (key.as_str(), meta.value()?.parse::<Expr>()?) {
                ("aliases" | "requires" | "surfaces", Expr::Array(values)) => {
                    let values = strings(values)?;
                    if key == "aliases" {
                        for value in &values {
                            validate_lowercase(value, "aliases")?;
                        }
                        result.aliases = values.into_iter().map(|value| value.value()).collect();
                    } else if key == "requires" {
                        for requirement in &values {
                            let value = requirement.value();
                            if value != "Connected" && !value.starts_with("Feature:") {
                                return Err(syn::Error::new_spanned(
                                    requirement,
                                    "requires values must be Connected or Feature:<name>",
                                ));
                            }
                        }
                        result.requirements =
                            values.into_iter().map(|value| value.value()).collect();
                    } else {
                        result.surfaces = values
                            .into_iter()
                            .map(|value| known_value(value, SURFACES, "surface"))
                            .collect::<syn::Result<_>>()?;
                    }
                }
                (key, Expr::Lit(value)) => {
                    let Lit::Str(value) = value.lit else {
                        return Err(meta.error("expected a string"));
                    };
                    match key {
                        "name" => {
                            validate_lowercase(&value, "name")?;
                            result.name = value.value();
                        }
                        "usage" => result.usage = value.value(),
                        "description" => result.description = value.value(),
                        "permission" => {
                            result.permission = known_value(value, PERMISSIONS, "permission")?;
                        }
                        "confirm" => {
                            result.confirm =
                                known_value(value, CONFIRM_POLICIES, "confirm policy")?;
                        }
                        "completion" => {
                            result.completion =
                                known_value(value, COMPLETION_PRIORITIES, "completion priority")?;
                        }
                        _ => return Err(meta.error("unknown command attribute")),
                    }
                }
                _ => return Err(meta.error("invalid command attribute")),
            }
            Ok(())
        })?;
        if result.name.is_empty()
            || result.usage.is_empty()
            || result.description.is_empty()
            || result.surfaces.is_empty()
        {
            return Err(syn::Error::new_spanned(
                variant,
                "name, usage, description and surfaces are required",
            ));
        }
        Ok(result)
    }
}

const PERMISSIONS: &[&str] = &["Anyone", "HalfOp", "Op", "Oper"];
const CONFIRM_POLICIES: &[&str] = &["None", "Menu", "Always"];
const COMPLETION_PRIORITIES: &[&str] = &["Everyday", "Other"];
const SURFACES: &[&str] = &[
    "Slash",
    "Palette",
    "UserMenu",
    "MessageMenu",
    "ChannelMenu",
    "NetworkMenu",
];

fn strings(values: ExprArray) -> syn::Result<Vec<LitStr>> {
    values
        .elems
        .into_iter()
        .map(|value| match value {
            Expr::Lit(value) => match value.lit {
                Lit::Str(value) => Ok(value),
                _ => Err(syn::Error::new_spanned(value, "expected a string")),
            },
            value => Err(syn::Error::new_spanned(value, "expected a string")),
        })
        .collect()
}

fn known_value(value: LitStr, allowed: &[&str], kind: &str) -> syn::Result<String> {
    let actual = value.value();
    if allowed.contains(&actual.as_str()) {
        Ok(actual)
    } else {
        Err(syn::Error::new_spanned(
            value,
            format!("unknown {kind} `{actual}`"),
        ))
    }
}

fn validate_lowercase(value: &LitStr, kind: &str) -> syn::Result<()> {
    let actual = value.value();
    if actual == actual.to_ascii_lowercase() {
        Ok(())
    } else {
        Err(syn::Error::new_spanned(
            value,
            format!("command {kind} must be lowercase"),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::Metadata;

    #[test]
    fn reads_command_metadata_and_defaults() {
        let variant: syn::Variant = syn::parse_quote! {
            #[command(name = "join", aliases = ["j"], usage = "cmd.join.usage",
                description = "cmd.join.description", requires = ["Feature:multi-prefix"],
                surfaces = ["Slash", "Palette"], secret)]
            Join { channels: ChannelList }
        };
        let metadata = Metadata::parse(&variant).expect("metadata is valid");
        assert_eq!(metadata.name, "join");
        assert_eq!(metadata.aliases, ["j"]);
        assert_eq!(metadata.permission, "Anyone");
        assert_eq!(metadata.confirm, "None");
        assert_eq!(metadata.completion, "Other");
        assert_eq!(metadata.requirements, ["Feature:multi-prefix"]);
        assert!(metadata.secret);
    }

    #[test]
    fn rejects_incomplete_metadata() {
        let variant: syn::Variant = syn::parse_quote! {
            #[command(name = "join", aliases = [], usage = "cmd.join.usage", surfaces = ["Slash"])]
            Join { channels: ChannelList }
        };
        assert!(Metadata::parse(&variant).is_err());
    }

    #[test]
    fn rejects_duplicate_and_unknown_policy_metadata() {
        for variant in [
            syn::parse_quote! {
                #[command(name = "join", name = "part", aliases = [], usage = "usage",
                    description = "description", surfaces = ["Slash"])]
                Join {}
            },
            syn::parse_quote! {
                #[command(name = "join", aliases = [], usage = "usage",
                    description = "description", permission = "Owner", surfaces = ["Slash"])]
                Join {}
            },
            syn::parse_quote! {
                #[command(name = "Join", aliases = [], usage = "usage",
                    description = "description", surfaces = ["Slash"])]
                Join {}
            },
        ] {
            assert!(Metadata::parse(&variant).is_err());
        }
    }
}
