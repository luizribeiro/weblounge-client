use syn::{Expr, ExprArray, Lit};

pub(crate) struct Metadata {
    pub(crate) name: String,
    pub(crate) aliases: Vec<String>,
    pub(crate) usage: String,
    pub(crate) description: String,
    pub(crate) requirements: Vec<String>,
    pub(crate) permission: String,
    pub(crate) surfaces: Vec<String>,
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
            confirm: "None".into(),
            secret: false,
        };
        let attribute = variant
            .attrs
            .iter()
            .find(|attribute| attribute.path().is_ident("command"))
            .ok_or_else(|| syn::Error::new_spanned(variant, "missing command attribute"))?;
        attribute.parse_nested_meta(|meta| {
            if meta.path.is_ident("secret") {
                result.secret = true;
                return Ok(());
            }
            let key = meta
                .path
                .get_ident()
                .map(ToString::to_string)
                .unwrap_or_default();
            match (key.as_str(), meta.value()?.parse::<Expr>()?) {
                ("aliases" | "requires" | "surfaces", Expr::Array(values)) => {
                    let values = strings(values)?;
                    if key == "aliases" {
                        result.aliases = values;
                    } else if key == "requires" {
                        if values.iter().any(|requirement| {
                            requirement != "Connected" && !requirement.starts_with("Feature:")
                        }) {
                            return Err(
                                meta.error("requires values must be Connected or Feature:<name>")
                            );
                        }
                        result.requirements = values;
                    } else {
                        result.surfaces = values;
                    }
                }
                (key, Expr::Lit(value)) => {
                    let Lit::Str(value) = value.lit else {
                        return Err(meta.error("expected a string"));
                    };
                    match key {
                        "name" => result.name = value.value(),
                        "usage" => result.usage = value.value(),
                        "description" => result.description = value.value(),
                        "permission" => result.permission = value.value(),
                        "confirm" => result.confirm = value.value(),
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

fn strings(values: ExprArray) -> syn::Result<Vec<String>> {
    values
        .elems
        .into_iter()
        .map(|value| match value {
            Expr::Lit(value) => match value.lit {
                Lit::Str(value) => Ok(value.value()),
                _ => Err(syn::Error::new_spanned(value, "expected a string")),
            },
            value => Err(syn::Error::new_spanned(value, "expected a string")),
        })
        .collect()
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
}
