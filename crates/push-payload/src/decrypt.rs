//! RFC 8291 decryption of one `aes128gcm` Web Push record.

use aes_gcm::{
    Aes128Gcm,
    aead::{Aead, KeyInit},
};
use hkdf::Hkdf;
use p256::{EncodedPoint, PublicKey, SecretKey, ecdh::diffie_hellman, pkcs8::DecodePrivateKey};
use sha2::Sha256;
use std::fmt;

const SALT_LENGTH: usize = 16;
const P256_PUBLIC_KEY_LENGTH: usize = 65;
const UNCOMPRESSED_POINT_PREFIX: u8 = 4;
const HEADER_LENGTH: usize = SALT_LENGTH + 4 + 1 + P256_PUBLIC_KEY_LENGTH;
const AUTHENTICATION_TAG_LENGTH: usize = 16;
const AUTH_SECRET_LENGTH: usize = 16;
const LAST_RECORD_DELIMITER: u8 = 2;

/// The receiver's private half of one push route.
#[derive(Clone, Eq, PartialEq)]
pub struct RouteKeys {
    /// The P-256 private key as PKCS #8 DER, the form `WebCrypto` exports.
    pub private_key_pkcs8: Vec<u8>,
    /// The route's 16-byte authentication secret.
    pub auth: Vec<u8>,
}

impl fmt::Debug for RouteKeys {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RouteKeys { .. }")
    }
}

/// Why a push record could not be decrypted.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum DecryptError {
    /// The record is shorter than its header plus one sealed byte.
    #[error("encrypted push payload is truncated")]
    Truncated,
    /// The header's record size or sender key is malformed.
    #[error("encrypted push payload has an invalid header")]
    InvalidHeader,
    /// The route's private key or authentication secret is malformed.
    #[error("invalid push route key material")]
    InvalidKeys,
    /// The record did not authenticate under the route's keys.
    #[error("encrypted push payload failed authentication")]
    Authentication,
    /// The plaintext lacks the final-record delimiter.
    #[error("encrypted push payload has invalid padding")]
    InvalidPadding,
}

/// Decrypts a single-record `aes128gcm` body addressed to `keys`.
///
/// # Errors
///
/// Returns which part of the record or key material was unusable.
pub fn decrypt_push_payload(record: &[u8], keys: &RouteKeys) -> Result<Vec<u8>, DecryptError> {
    let header = Header::parse(record)?;
    let receiver = SecretKey::from_pkcs8_der(&keys.private_key_pkcs8)
        .map_err(|_| DecryptError::InvalidKeys)?;
    let sender =
        PublicKey::from_sec1_bytes(header.sender_key).map_err(|_| DecryptError::InvalidHeader)?;
    let shared = diffie_hellman(receiver.to_nonzero_scalar(), sender.as_affine());
    let sealing = RecordSealing::derive(
        shared.raw_secret_bytes(),
        &keys.auth,
        EncodedPoint::from(receiver.public_key()).as_bytes(),
        header.sender_key,
        header.salt,
    )?;
    let padded = Aes128Gcm::new(&sealing.content_key.into())
        .decrypt(&sealing.nonce.into(), header.sealed)
        .map_err(|_| DecryptError::Authentication)?;
    unpad(padded)
}

struct Header<'a> {
    salt: &'a [u8; SALT_LENGTH],
    sender_key: &'a [u8],
    sealed: &'a [u8],
}

impl<'a> Header<'a> {
    fn parse(record: &'a [u8]) -> Result<Self, DecryptError> {
        if record.len() < HEADER_LENGTH + AUTHENTICATION_TAG_LENGTH + 1 {
            return Err(DecryptError::Truncated);
        }
        let (salt, rest) = record
            .split_first_chunk::<SALT_LENGTH>()
            .ok_or(DecryptError::Truncated)?;
        let (record_size, rest) = rest
            .split_first_chunk::<4>()
            .ok_or(DecryptError::Truncated)?;
        let (key_length, rest) = rest.split_first().ok_or(DecryptError::Truncated)?;
        let (sender_key, sealed) = rest.split_at(P256_PUBLIC_KEY_LENGTH);
        let valid = usize::try_from(u32::from_be_bytes(*record_size))
            .is_ok_and(|size| size > AUTHENTICATION_TAG_LENGTH + 1)
            && usize::from(*key_length) == P256_PUBLIC_KEY_LENGTH
            && sender_key.first() == Some(&UNCOMPRESSED_POINT_PREFIX);
        if !valid {
            return Err(DecryptError::InvalidHeader);
        }
        Ok(Self {
            salt,
            sender_key,
            sealed,
        })
    }
}

/// The AES-GCM key and nonce RFC 8291 derives for one record.
pub(crate) struct RecordSealing {
    pub(crate) content_key: [u8; 16],
    pub(crate) nonce: [u8; 12],
}

impl RecordSealing {
    pub(crate) fn derive(
        shared_secret: &[u8],
        auth: &[u8],
        receiver_public: &[u8],
        sender_public: &[u8],
        salt: &[u8],
    ) -> Result<Self, DecryptError> {
        if auth.len() != AUTH_SECRET_LENGTH {
            return Err(DecryptError::InvalidKeys);
        }
        let key_info = [
            b"WebPush: info\0".as_slice(),
            receiver_public,
            sender_public,
        ]
        .concat();
        let mut input_key = [0; 32];
        expand(auth, shared_secret, &key_info, &mut input_key)?;
        let mut sealing = Self {
            content_key: [0; 16],
            nonce: [0; 12],
        };
        expand(
            salt,
            &input_key,
            b"Content-Encoding: aes128gcm\0",
            &mut sealing.content_key,
        )?;
        expand(
            salt,
            &input_key,
            b"Content-Encoding: nonce\0",
            &mut sealing.nonce,
        )?;
        Ok(sealing)
    }
}

fn expand(salt: &[u8], input: &[u8], info: &[u8], output: &mut [u8]) -> Result<(), DecryptError> {
    Hkdf::<Sha256>::new(Some(salt), input)
        .expand(info, output)
        .map_err(|_| DecryptError::InvalidKeys)
}

fn unpad(mut padded: Vec<u8>) -> Result<Vec<u8>, DecryptError> {
    let delimiter = padded
        .iter()
        .rposition(|byte| *byte != 0)
        .ok_or(DecryptError::InvalidPadding)?;
    if padded[delimiter] != LAST_RECORD_DELIMITER {
        return Err(DecryptError::InvalidPadding);
    }
    padded.truncate(delimiter);
    Ok(padded)
}

#[cfg(test)]
#[path = "decrypt_tests.rs"]
pub(crate) mod tests;
