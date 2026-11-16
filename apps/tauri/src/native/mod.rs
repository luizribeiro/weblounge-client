//! The iOS shell's native half (design 33): the page's push, badge and notification commands,
//! and the taps and lifecycle changes the Swift side reports.

mod answers;
#[cfg(target_os = "ios")]
pub mod commands;
#[cfg(target_os = "ios")]
mod events;
mod failure;
mod shell_event;

#[cfg(target_os = "ios")]
pub use events::{PageLoad, track_page_load, watch};
