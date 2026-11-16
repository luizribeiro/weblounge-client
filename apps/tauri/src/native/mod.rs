//! The iOS shell's native half (design 33): the page's push, badge and notification commands,
//! and the taps and lifecycle changes the Swift side reports.

#[cfg(target_os = "ios")]
pub mod commands;
mod failure;
