use std::ffi::{CStr, CString, c_char};

use serde_json::Value;

use super::WebloungeBytes;
use crate::decrypt::tests::{rfc_keys, seal_for_rfc_receiver};

// Declared as the Swift extension sees them, so calls resolve through the exported C symbols.
unsafe extern "C" {
    fn weblounge_prepare_notification(
        ciphertext: WebloungeBytes,
        private_key_pkcs8: WebloungeBytes,
        auth: WebloungeBytes,
        network_label: *const c_char,
        nickname: *const c_char,
    ) -> *mut c_char;
    fn weblounge_counted_notification_body(
        body: *const c_char,
        count: u32,
        new_messages: *const c_char,
    ) -> *mut c_char;
    fn weblounge_string_free(value: *mut c_char);
}

fn lent(bytes: &[u8]) -> WebloungeBytes {
    WebloungeBytes {
        data: bytes.as_ptr(),
        len: bytes.len(),
    }
}

fn c(text: &str) -> CString {
    CString::new(text).expect("no interior NUL")
}

fn take(value: *mut c_char) -> Option<String> {
    if value.is_null() {
        return None;
    }
    // SAFETY: the library returned this NUL-terminated string and it is released once below.
    let text = unsafe { CStr::from_ptr(value) }
        .to_str()
        .expect("UTF-8")
        .to_owned();
    // SAFETY: `value` came from the library and is not used again.
    unsafe { weblounge_string_free(value) };
    Some(text)
}

fn prepare(
    ciphertext: &[u8],
    network_label: *const c_char,
    nickname: *const c_char,
) -> Option<String> {
    let keys = rfc_keys();
    // SAFETY: every slice and string outlives the call.
    take(unsafe {
        weblounge_prepare_notification(
            lent(ciphertext),
            lent(&keys.private_key_pkcs8),
            lent(&keys.auth),
            network_label,
            nickname,
        )
    })
}

#[test]
fn round_trips_an_encrypted_mention_through_the_c_abi() {
    let record = seal_for_rfc_receiver(
        "@time=2026-11-16T09:41:07.512Z;msgid=nse-1 :mel!m@example.test PRIVMSG #Lounge :weblounge: lunch?\u{2}"
            .as_bytes(),
    );
    let (label, nick) = (c("Lounge"), c("weblounge"));

    let outcome: Value = serde_json::from_str(
        &prepare(&record, label.as_ptr(), nick.as_ptr()).expect("a prepared outcome"),
    )
    .expect("json");

    assert_eq!(outcome["outcome"], "prepared");
    assert_eq!(outcome["notification"]["title"], "mel in #Lounge");
    assert_eq!(outcome["notification"]["threadId"], "Lounge/#lounge");
    assert_eq!(outcome["notification"]["userInfo"]["messageId"], "nse-1");
    assert_eq!(outcome["notification"]["pushed"]["route"], "/Lounge/Lounge");
}

#[test]
fn reports_a_decrypt_failure_as_json() {
    let (label, nick) = (c("Lounge"), c("weblounge"));

    let outcome: Value =
        serde_json::from_str(&prepare(&[0; 12], label.as_ptr(), nick.as_ptr()).expect("outcome"))
            .expect("json");

    assert_eq!(outcome["stage"], "decrypt");
}

#[test]
fn returns_null_for_null_or_non_utf8_arguments() {
    let label = c("Lounge");
    let latin1 = CString::new(b"caf\xe9".to_vec()).expect("no interior NUL");
    let dangling = WebloungeBytes {
        data: std::ptr::null(),
        len: 4,
    };
    let keys = rfc_keys();

    assert_eq!(prepare(&[0; 12], label.as_ptr(), std::ptr::null()), None);
    assert_eq!(prepare(&[0; 12], label.as_ptr(), latin1.as_ptr()), None);
    // SAFETY: the null pointer is the input under test; the rest outlive the call.
    let rejected = take(unsafe {
        weblounge_prepare_notification(
            dangling,
            lent(&keys.private_key_pkcs8),
            lent(&keys.auth),
            label.as_ptr(),
            label.as_ptr(),
        )
    });
    assert_eq!(rejected, None);
}

#[test]
fn accepts_an_empty_null_buffer() {
    let (label, nick) = (c("Lounge"), c("weblounge"));
    let keys = rfc_keys();
    let empty = WebloungeBytes {
        data: std::ptr::null(),
        len: 0,
    };

    // SAFETY: an empty buffer may be null; the rest outlive the call.
    let outcome = take(unsafe {
        weblounge_prepare_notification(
            empty,
            lent(&keys.private_key_pkcs8),
            lent(&keys.auth),
            label.as_ptr(),
            nick.as_ptr(),
        )
    })
    .expect("an outcome");

    assert!(outcome.contains(r#""stage":"decrypt""#), "{outcome}");
}

#[test]
fn rejects_null_or_non_utf8_count_arguments() {
    let template = c("· {count} new messages");
    let latin1 = CString::new(b"caf\xe9".to_vec()).expect("no interior NUL");

    // SAFETY: the null and Latin-1 strings are the inputs under test; both outlive the calls.
    let (null_body, latin1_template) = unsafe {
        (
            weblounge_counted_notification_body(std::ptr::null(), 2, template.as_ptr()),
            weblounge_counted_notification_body(template.as_ptr(), 2, latin1.as_ptr()),
        )
    };

    assert!(null_body.is_null());
    assert!(latin1_template.is_null());
}

#[test]
fn counts_a_body_through_the_c_abi() {
    let (body, template) = (c("lunch?"), c("· {count} new messages"));

    // SAFETY: both strings outlive the call.
    let counted =
        take(unsafe { weblounge_counted_notification_body(body.as_ptr(), 4, template.as_ptr()) });

    assert_eq!(counted.as_deref(), Some("lunch?\n· 4 new messages"));
}

#[test]
fn ignores_freeing_null() {
    // SAFETY: null is documented as a no-op.
    unsafe { weblounge_string_free(std::ptr::null_mut()) };
}
