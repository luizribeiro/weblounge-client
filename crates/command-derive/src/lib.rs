//! Derives the built-in slash-command parser and runtime specification table.

use proc_macro::TokenStream;

/// Derives command metadata and parsing from one enum declaration.
#[proc_macro_derive(Command, attributes(command))]
pub fn derive_command(_input: TokenStream) -> TokenStream {
    TokenStream::new()
}
