use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

use aes_gcm::{
    Aes128Gcm,
    aead::{Aead, KeyInit},
};
use p256::{EncodedPoint, SecretKey, ecdh::diffie_hellman, pkcs8::DecodePrivateKey};

use super::{DecryptError, RecordSealing, RouteKeys, decrypt_push_payload};

/// The RFC 8291 §5 receiver key, exported as PKCS #8 by `WebCrypto`.
const RFC_RECEIVER_PKCS8: &str = "308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420ab5757a70dd4a53e553a6bbf71ffefea2874ec07a6b379e3c48f895a02dc33dea144034200042571b2becdfde360551aaf1ed0f4cd366c11cebe555f89bcb7b186a53339173168ece2ebe018597bd30479b86e3c8f8eced577ca59187e9246990db682008b0e";
const RFC_AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";
const RFC_RECORD: &str = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

pub(crate) fn rfc_keys() -> RouteKeys {
    RouteKeys {
        private_key_pkcs8: hex(RFC_RECEIVER_PKCS8),
        auth: base64url(RFC_AUTH),
    }
}

pub(crate) fn rfc_record() -> Vec<u8> {
    base64url(RFC_RECORD)
}

/// Seals `padded` for the RFC receiver the way a push service would.
pub(crate) fn seal_for_rfc_receiver(padded: &[u8]) -> Vec<u8> {
    let keys = rfc_keys();
    let receiver = SecretKey::from_pkcs8_der(&keys.private_key_pkcs8)
        .expect("RFC key")
        .public_key();
    let sender = SecretKey::from_slice(&[7; 32]).expect("sender scalar");
    let sender_public = EncodedPoint::from(sender.public_key());
    let shared = diffie_hellman(sender.to_nonzero_scalar(), receiver.as_affine());
    let salt = [9; 16];
    let sealing = RecordSealing::derive(
        shared.raw_secret_bytes(),
        &keys.auth,
        EncodedPoint::from(receiver).as_bytes(),
        sender_public.as_bytes(),
        &salt,
    )
    .expect("record keys");
    let sealed = Aes128Gcm::new(&sealing.content_key.into())
        .encrypt(&sealing.nonce.into(), padded)
        .expect("seal");
    [
        salt.as_slice(),
        &4096_u32.to_be_bytes(),
        &[65],
        sender_public.as_bytes(),
        &sealed,
    ]
    .concat()
}

pub(crate) fn base64url(value: &str) -> Vec<u8> {
    URL_SAFE_NO_PAD
        .decode(value)
        .expect("test vector is base64url")
}

fn hex(value: &str) -> Vec<u8> {
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).expect("hex"))
        .collect()
}

#[test]
fn decrypts_the_rfc_8291_section_5_vector() {
    assert_eq!(
        decrypt_push_payload(&rfc_record(), &rfc_keys()).as_deref(),
        Ok(b"When I grow up, I want to be a watermelon".as_slice())
    );
}

#[test]
fn strips_trailing_padding_after_the_delimiter() {
    let record = seal_for_rfc_receiver(b"PING :push-registration\x02\0\0\0");

    assert_eq!(
        decrypt_push_payload(&record, &rfc_keys()).as_deref(),
        Ok(b"PING :push-registration".as_slice())
    );
}

#[test]
fn rejects_a_record_without_the_final_delimiter() {
    for padded in [b"PING\x01\0".as_slice(), b"\0\0\0"] {
        assert_eq!(
            decrypt_push_payload(&seal_for_rfc_receiver(padded), &rfc_keys()),
            Err(DecryptError::InvalidPadding)
        );
    }
}

#[test]
fn rejects_a_tampered_record() {
    let mut record = rfc_record();
    let last = record.len() - 1;
    record[last] ^= 1;

    assert_eq!(
        decrypt_push_payload(&record, &rfc_keys()),
        Err(DecryptError::Authentication)
    );
}

#[test]
fn rejects_truncated_and_malformed_headers() {
    let record = rfc_record();
    let mut wrong_key_length = record.clone();
    wrong_key_length[20] = 64;
    let mut tiny_record_size = record.clone();
    tiny_record_size[16..20].copy_from_slice(&17_u32.to_be_bytes());

    assert_eq!(
        decrypt_push_payload(&record[..90], &rfc_keys()),
        Err(DecryptError::Truncated)
    );
    assert_eq!(
        decrypt_push_payload(&wrong_key_length, &rfc_keys()),
        Err(DecryptError::InvalidHeader)
    );
    assert_eq!(
        decrypt_push_payload(&tiny_record_size, &rfc_keys()),
        Err(DecryptError::InvalidHeader)
    );
}

#[test]
fn rejects_a_sender_key_that_is_not_an_uncompressed_point() {
    let mut compressed_prefix = rfc_record();
    compressed_prefix[21] = 2;
    let mut off_curve = rfc_record();
    off_curve[22..86].fill(1);

    for record in [compressed_prefix, off_curve] {
        assert_eq!(
            decrypt_push_payload(&record, &rfc_keys()),
            Err(DecryptError::InvalidHeader)
        );
    }
}

#[test]
fn fails_authentication_under_another_routes_secret() {
    let other_auth = RouteKeys {
        auth: vec![1; 16],
        ..rfc_keys()
    };

    assert_eq!(
        decrypt_push_payload(&rfc_record(), &other_auth),
        Err(DecryptError::Authentication)
    );
}

#[test]
fn keeps_route_secrets_out_of_debug_output() {
    assert_eq!(format!("{:?}", rfc_keys()), "RouteKeys { .. }");
}

#[test]
fn rejects_unusable_route_keys() {
    let short_auth = RouteKeys {
        auth: vec![0; 8],
        ..rfc_keys()
    };
    let garbage_key = RouteKeys {
        private_key_pkcs8: vec![0x30, 0x03, 0x02, 0x01, 0x00],
        ..rfc_keys()
    };

    assert_eq!(
        decrypt_push_payload(&rfc_record(), &short_auth),
        Err(DecryptError::InvalidKeys)
    );
    assert_eq!(
        decrypt_push_payload(&rfc_record(), &garbage_key),
        Err(DecryptError::InvalidKeys)
    );
}
