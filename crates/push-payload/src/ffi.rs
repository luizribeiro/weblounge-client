//! The C ABI the iOS Notification Service Extension links as a static library.
//!
//! Every function returns either null or a string the caller owns and must release with
//! [`weblounge_string_free`]. The declarations live in `include/weblounge_push_payload.h`.

#![allow(unsafe_code)]

use std::ffi::{CStr, CString, c_char};

use crate::{NotificationStrings, RouteKeys, RouteMeta, counted_body, prepare_notification_json};

/// Bytes the caller lends for the duration of one call.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct WebloungeBytes {
    /// The first byte; may be null only when `len` is zero.
    pub data: *const u8,
    /// The number of bytes at `data`, at most `isize::MAX`.
    pub len: usize,
}

/// Decrypts, parses and formats one push, returning the JSON of
/// [`crate::prepare_notification_json`].
///
/// Returns null when a pointer is null or a string is not UTF-8.
///
/// # Safety
///
/// Each `WebloungeBytes` must describe readable memory, and each string must be NUL-terminated,
/// for the duration of the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn weblounge_prepare_notification(
    ciphertext: WebloungeBytes,
    private_key_pkcs8: WebloungeBytes,
    auth: WebloungeBytes,
    network_label: *const c_char,
    nickname: *const c_char,
) -> *mut c_char {
    // SAFETY: the caller guarantees every argument per this function's contract.
    let arguments = unsafe {
        (
            bytes(ciphertext),
            bytes(private_key_pkcs8),
            bytes(auth),
            text(network_label),
            text(nickname),
        )
    };
    let (
        Some(ciphertext),
        Some(private_key_pkcs8),
        Some(auth),
        Some(network_label),
        Some(nickname),
    ) = arguments
    else {
        return std::ptr::null_mut();
    };
    owned(prepare_notification_json(
        ciphertext,
        &RouteKeys {
            private_key_pkcs8: private_key_pkcs8.to_vec(),
            auth: auth.to_vec(),
        },
        &RouteMeta {
            network_label: network_label.to_owned(),
            nickname: nickname.to_owned(),
        },
    ))
}

/// Appends the unread-count line; see [`crate::counted_body`].
///
/// `new_messages` is a template whose first `{count}` becomes the number.
///
/// Returns null when a pointer is null or a string is not UTF-8.
///
/// # Safety
///
/// Both strings must be NUL-terminated and readable for the duration of the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn weblounge_counted_notification_body(
    body: *const c_char,
    count: u32,
    new_messages: *const c_char,
) -> *mut c_char {
    // SAFETY: the caller guarantees both strings per this function's contract.
    let (Some(body), Some(new_messages)) = (unsafe { text(body) }, unsafe { text(new_messages) })
    else {
        return std::ptr::null_mut();
    };
    owned(counted_body(
        body,
        count,
        &NotificationStrings {
            new_messages: new_messages.to_owned(),
        },
    ))
}

/// Releases a string this library returned. Null is ignored.
///
/// # Safety
///
/// `value` must be null or a pointer this library returned that was not yet released.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn weblounge_string_free(value: *mut c_char) {
    if !value.is_null() {
        // SAFETY: the caller guarantees `value` came from `CString::into_raw` below.
        drop(unsafe { CString::from_raw(value) });
    }
}

/// # Safety
///
/// `value.data` must point at `value.len` readable bytes, unless `len` is zero, and `len` must not
/// exceed `isize::MAX`.
unsafe fn bytes<'a>(value: WebloungeBytes) -> Option<&'a [u8]> {
    if value.len == 0 {
        return Some(&[]);
    }
    if value.data.is_null() {
        return None;
    }
    // SAFETY: non-null and, per the caller, valid for `len` bytes.
    Some(unsafe { std::slice::from_raw_parts(value.data, value.len) })
}

/// # Safety
///
/// `value` must be null or point at a NUL-terminated string.
unsafe fn text<'a>(value: *const c_char) -> Option<&'a str> {
    if value.is_null() {
        return None;
    }
    // SAFETY: non-null and, per the caller, NUL-terminated.
    unsafe { CStr::from_ptr(value) }.to_str().ok()
}

fn owned(value: String) -> *mut c_char {
    CString::new(value).map_or(std::ptr::null_mut(), CString::into_raw)
}

#[cfg(test)]
#[path = "ffi_tests.rs"]
mod tests;
