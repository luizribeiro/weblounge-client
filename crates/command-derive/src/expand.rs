use std::collections::HashSet;

use quote::{format_ident, quote};
use syn::{Data, DeriveInput, Fields, Type};

use crate::metadata::Metadata;

pub(crate) fn derive(input: DeriveInput) -> syn::Result<proc_macro2::TokenStream> {
    let Data::Enum(data) = input.data else {
        return Err(syn::Error::new_spanned(
            input.ident,
            "Command requires an enum",
        ));
    };
    let enum_name = input.ident;
    let mut names = HashSet::new();
    let mut parse_arms = Vec::new();
    let mut specs = Vec::new();

    for variant in data.variants {
        let metadata = Metadata::parse(&variant)?;
        for name in std::iter::once(&metadata.name).chain(&metadata.aliases) {
            if !names.insert(name.clone()) {
                return Err(syn::Error::new_spanned(
                    &variant.ident,
                    "duplicate command name or alias",
                ));
            }
        }
        let Fields::Named(fields) = &variant.fields else {
            return Err(syn::Error::new_spanned(
                &variant.ident,
                "command variants require named fields",
            ));
        };
        let ident = &variant.ident;
        let field_names = fields
            .named
            .iter()
            .filter_map(|field| field.ident.as_ref())
            .collect::<Vec<_>>();
        let field_types = fields
            .named
            .iter()
            .map(|field| &field.ty)
            .collect::<Vec<_>>();
        let last = field_types.len().saturating_sub(1);
        let parses = field_names
            .iter()
            .zip(&field_types)
            .enumerate()
            .map(|(index, (name, ty))| {
                let rest_guard = (index != last).then(|| {
                    quote! {
                        const { assert!(!<#ty as CommandArg>::CONSUMES_REST, "rest-consuming argument must be last"); }
                    }
                });
                quote! {
                    #rest_guard
                    let #name = <#ty as CommandArg>::parse(&mut tokens, context)?;
                }
            });
        let patterns = std::iter::once(&metadata.name)
            .chain(&metadata.aliases)
            .collect::<Vec<_>>();
        parse_arms.push(quote! {
            #(#patterns)|* => {
                #(#parses)*
                tokens.finish()?;
                Ok(Self::#ident { #(#field_names),* })
            }
        });
        specs.push(spec(&metadata, &field_names, &field_types));
    }

    Ok(quote! {
        impl #enum_name {
            pub(crate) fn parse_slash(input: &str, context: &ParseContext) -> Result<Self, InputError> {
                let mut tokens = Tokens::new(input);
                let name = tokens.word().map(str::to_owned).ok_or(InputError::MissingArgument)?;
                match name.to_ascii_lowercase().as_str() {
                    #(#parse_arms,)*
                    _ => Err(InputError::UnknownCommand(name)),
                }
            }

            pub(crate) fn specs() -> Vec<CommandSpec> {
                vec![#(#specs),*]
            }
        }
    })
}

fn spec(
    metadata: &Metadata,
    field_names: &[&syn::Ident],
    field_types: &[&Type],
) -> proc_macro2::TokenStream {
    let Metadata {
        name,
        aliases,
        usage,
        description,
        requirements,
        permission,
        surfaces,
        confirm,
        secret,
    } = metadata;
    let permission = format_ident!("{permission}");
    let confirm = format_ident!("{confirm}");
    let surfaces = surfaces.iter().map(|surface| format_ident!("{surface}"));
    let arguments = field_names.iter().zip(field_types).map(|(name, ty)| {
        let name = name.to_string();
        quote! { <#ty as CommandArg>::spec(#name) }
    });
    let requirements = requirements.iter().map(|requirement| {
        if let Some(feature) = requirement.strip_prefix("Feature:") {
            quote! { CommandRequirement::Feature(#feature.into()) }
        } else {
            let requirement = format_ident!("{requirement}");
            quote! { CommandRequirement::#requirement }
        }
    });
    quote! {
        CommandSpec {
            name: #name.into(), aliases: vec![#(#aliases.into()),*], arguments: vec![#(#arguments),*],
            usage: #usage.into(), description: #description.into(),
            requirements: vec![#(#requirements),*], permission: CommandPermission::#permission,
            surfaces: vec![#(CommandSurface::#surfaces),*], confirm: ConfirmPolicy::#confirm,
            secret_arguments: #secret,
        }
    }
}
