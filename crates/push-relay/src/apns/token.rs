use std::{
    sync::{Mutex, PoisonError},
    time::Duration,
};

use p256::ecdsa::SigningKey;
use serde::Serialize;
use tokio::time::Instant;

use crate::{
    Error, Result,
    jwt::{sign_es256, unix_seconds},
};

/// Apple rejects provider tokens older than an hour and throttles refreshes more often than
/// every 20 minutes.
const REFRESH_AFTER: Duration = Duration::from_mins(40);

/// The ES256 provider token APNs requires, reused until [`REFRESH_AFTER`].
pub(crate) struct ProviderTokens {
    key: SigningKey,
    key_id: String,
    team_id: String,
    cached: Mutex<Option<CachedToken>>,
}

struct CachedToken {
    jwt: String,
    issued: Instant,
}

#[derive(Serialize)]
struct Header<'a> {
    alg: &'static str,
    kid: &'a str,
}

#[derive(Serialize)]
struct Claims<'a> {
    iss: &'a str,
    iat: u64,
}

impl ProviderTokens {
    pub(crate) fn new(key: SigningKey, key_id: String, team_id: String) -> Self {
        Self {
            key,
            key_id,
            team_id,
            cached: Mutex::new(None),
        }
    }

    pub(crate) fn current(&self) -> Result<String> {
        self.at(Instant::now(), unix_seconds()?)
    }

    /// Forgets the cached token, so the next delivery signs a fresh one.
    pub(super) fn invalidate(&self) {
        *self.cached.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    pub(super) fn at(&self, now: Instant, unix_now: u64) -> Result<String> {
        let mut cached = self
            .cached
            .lock()
            .map_err(|_| Error::Config("APNs token cache is unavailable".to_owned()))?;
        if let Some(token) = cached
            .as_ref()
            .filter(|token| now.saturating_duration_since(token.issued) < REFRESH_AFTER)
        {
            return Ok(token.jwt.clone());
        }
        let jwt = sign_es256(
            &self.key,
            &Header {
                alg: "ES256",
                kid: &self.key_id,
            },
            &Claims {
                iss: &self.team_id,
                iat: unix_now,
            },
        )?;
        *cached = Some(CachedToken {
            jwt: jwt.clone(),
            issued: now,
        });
        Ok(jwt)
    }
}

impl std::fmt::Debug for ProviderTokens {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProviderTokens")
            .field("key_id", &self.key_id)
            .field("team_id", &self.team_id)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::time::Instant;

    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use p256::{SecretKey, ecdsa::SigningKey};
    use rand_core::OsRng;
    use serde_json::{Value, json};

    use super::ProviderTokens;

    const ISSUED: u64 = 1_762_000_000;

    fn tokens() -> ProviderTokens {
        ProviderTokens::new(
            SigningKey::from(SecretKey::random(&mut OsRng)),
            "ABC123DEFG".to_owned(),
            "DEF123GHIJ".to_owned(),
        )
    }

    fn part(jwt: &str, index: usize) -> Value {
        let encoded = jwt.split('.').nth(index).expect("JWT part");
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).expect("base64url")).expect("JSON")
    }

    #[test]
    fn token_names_the_key_and_team() {
        let jwt = tokens().at(Instant::now(), ISSUED).expect("token");
        assert_eq!(part(&jwt, 0), json!({"alg": "ES256", "kid": "ABC123DEFG"}));
        assert_eq!(part(&jwt, 1), json!({"iss": "DEF123GHIJ", "iat": ISSUED}));
    }

    #[test]
    fn token_is_reused_for_forty_minutes_then_reissued() {
        let tokens = tokens();
        let start = Instant::now();
        let first = tokens.at(start, ISSUED).expect("first token");
        let reused = tokens
            .at(start + Duration::from_secs(39 * 60 + 59), ISSUED + 2_399)
            .expect("cached token");
        assert_eq!(reused, first);

        let refreshed = tokens
            .at(start + Duration::from_mins(40), ISSUED + 2_400)
            .expect("refreshed token");
        assert_eq!(part(&refreshed, 1)["iat"], ISSUED + 2_400);
        let reused_again = tokens
            .at(start + Duration::from_mins(41), ISSUED + 2_460)
            .expect("new cached token");
        assert_eq!(reused_again, refreshed);
    }

    #[test]
    fn an_invalidated_token_is_reissued_at_once() {
        let tokens = tokens();
        let start = Instant::now();
        tokens.at(start, ISSUED).expect("first token");
        tokens.invalidate();
        let reissued = tokens
            .at(start + Duration::from_secs(1), ISSUED + 1)
            .expect("token after invalidation");
        assert_eq!(part(&reissued, 1)["iat"], ISSUED + 1);
    }
}
