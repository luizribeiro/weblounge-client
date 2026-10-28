//! Derives the built-in slash-command parser and runtime specification table.

use proc_macro::TokenStream;
use syn::{Data, DeriveInput, parse_macro_input};

mod metadata;

/// Derives command metadata and parsing from one enum declaration.
#[proc_macro_derive(Command, attributes(command))]
pub fn derive_command(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    if let Data::Enum(data) = input.data {
        for variant in data.variants {
            if let Err(error) = metadata::Metadata::parse(&variant) {
                return error.into_compile_error().into();
            }
        }
    }
    TokenStream::new()
}
