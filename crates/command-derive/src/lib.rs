//! Derives the built-in slash-command parser and runtime specification table.

use proc_macro::TokenStream;
use syn::{DeriveInput, parse_macro_input};

mod expand;
mod metadata;

/// Derives command metadata and parsing from one enum declaration.
#[proc_macro_derive(Command, attributes(command))]
pub fn derive_command(input: TokenStream) -> TokenStream {
    expand::derive(parse_macro_input!(input as DeriveInput))
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}
