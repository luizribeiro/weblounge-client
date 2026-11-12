//! The native half of the page's `Notification` API.

#[cfg(target_os = "macos")]
#[allow(dead_code)]
mod center;
#[allow(dead_code)]
mod model;
#[allow(dead_code)]
mod service;
