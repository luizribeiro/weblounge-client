use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::ecdsa::{Signature, SigningKey, signature::Signer as _};
use serde::Serialize;

use crate::{Error, Result};

/// JOSE requires the raw `r || s` signature, not the DER form `p256` produces by default.
pub(crate) fn sign_es256(
    key: &SigningKey,
    header: &impl Serialize,
    claims: &impl Serialize,
) -> Result<String> {
    let header = encode_json(header)?;
    let claims = encode_json(claims)?;
    let signing_input = format!("{header}.{claims}");
    let signature: Signature = key.sign(signing_input.as_bytes());
    Ok(format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    ))
}

fn encode_json(value: &impl Serialize) -> Result<String> {
    serde_json::to_vec(value)
        .map(|json| URL_SAFE_NO_PAD.encode(json))
        .map_err(|error| Error::Crypto(error.to_string()))
}

pub(crate) fn unix_seconds() -> Result<u64> {
    u64::try_from(time::OffsetDateTime::now_utc().unix_timestamp())
        .map_err(|_| Error::Crypto("system clock precedes the Unix epoch".to_owned()))
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use p256::{
        SecretKey,
        ecdsa::{Signature, SigningKey, VerifyingKey, signature::Verifier as _},
    };
    use rand_core::OsRng;
    use serde_json::{Value, json};

    #[test]
    fn signs_a_verifiable_compact_token() {
        let key = SigningKey::from(SecretKey::random(&mut OsRng));
        let token = super::sign_es256(
            &key,
            &json!({"alg": "ES256", "kid": "ABC123DEFG"}),
            &json!({"iss": "DEF123GHIJ", "iat": 1_762_000_000}),
        )
        .expect("token");

        let parts = token.split('.').collect::<Vec<_>>();
        assert_eq!(parts.len(), 3);
        let decode = |part: &str| -> Value {
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part).expect("base64url")).expect("JSON")
        };
        assert_eq!(
            decode(parts[0]),
            json!({"alg": "ES256", "kid": "ABC123DEFG"})
        );
        assert_eq!(decode(parts[1])["iss"], "DEF123GHIJ");
        let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(parts[2]).expect("sig"))
            .expect("raw r || s signature");
        VerifyingKey::from(&key)
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .expect("valid signature");
    }
}
