use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::validated::validated_string;

const MAX_ROUTE_ID_CHARS: usize = 64;
const P256DH_CHARS: usize = 87;
const AUTH_CHARS: usize = 22;

validated_string!(
    /// The relay's opaque route identity, 22 characters today. It also names the route's
    /// keychain item, so it is held to the relay's URL-safe Base64 alphabet, with room for the
    /// relay to lengthen it.
    RouteId,
    is_route_id
);

validated_string!(
    /// An uncompressed P-256 public key (65 bytes) in unpadded URL-safe Base64.
    P256dhKey,
    is_p256dh_key
);

validated_string!(
    /// A 16-byte RFC 8291 authentication secret in unpadded URL-safe Base64.
    AuthSecret,
    is_auth_secret
);

fn is_route_id(value: &str) -> bool {
    (1..=MAX_ROUTE_ID_CHARS).contains(&value.len()) && is_base64url(value)
}

fn is_p256dh_key(value: &str) -> bool {
    value.len() == P256DH_CHARS && value.starts_with('B') && is_base64url(value)
}

fn is_auth_secret(value: &str) -> bool {
    value.len() == AUTH_CHARS && is_base64url(value)
}

fn is_base64url(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// What the extension needs to format a route's pushes, mirroring the page's
/// `PushNotificationRoute`: the nickname decides whether a message is a direct message.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RouteMeta {
    /// The engine's network identity.
    #[ts(type = "number")]
    pub network_id: u64,
    /// The network label used in buffer routes and conversation tags.
    pub network_label: String,
    /// The user's nickname on that network.
    pub nickname: String,
}

/// `create_route_keys`: makes a route's key pair and auth secret and stores them, with the
/// route's metadata, where the extension can read them.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreateRouteKeysRequest {
    /// The relay route the keys belong to.
    pub route_id: RouteId,
    /// How the extension formats this route's pushes.
    pub route: RouteMeta,
}

/// `drop_route_keys`: forgets a route's keys and metadata; dropping an unknown route succeeds.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DropRouteKeysRequest {
    /// The relay route to forget.
    pub route_id: RouteId,
}

/// The public half of a route's keys, which the page puts in the engine's `PushRoute`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct RouteKeys {
    /// The route's public key.
    pub p256dh: P256dhKey,
    /// The route's authentication secret.
    pub auth: AuthSecret,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        AuthSecret, CreateRouteKeysRequest, DropRouteKeysRequest, P256dhKey, RouteId, RouteKeys,
        RouteMeta,
    };
    use crate::InvalidValue;

    const ROUTE_ID: &str = "Xq3vY0bH2kRmT7nW9pLs1A";
    const P256DH: &str =
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";

    #[test]
    fn a_create_request_round_trips_with_its_route_metadata() {
        let request = CreateRouteKeysRequest {
            route_id: RouteId::try_from(ROUTE_ID.to_owned()).expect("valid route id"),
            route: RouteMeta {
                network_id: 3,
                network_label: "Libera".to_owned(),
                nickname: "weblounge".to_owned(),
            },
        };
        let value = json!({
            "routeId": ROUTE_ID,
            "route": { "networkId": 3, "networkLabel": "Libera", "nickname": "weblounge" },
        });

        assert_eq!(serde_json::to_value(&request).expect("serializes"), value);
        assert_eq!(
            serde_json::from_value::<CreateRouteKeysRequest>(value).expect("parses"),
            request
        );
    }

    #[test]
    fn a_drop_request_with_an_unsafe_route_id_does_not_deserialize() {
        let ok = json!({ "routeId": ROUTE_ID });
        let bad = json!({ "routeId": "../other-route" });
        assert!(serde_json::from_value::<DropRouteKeysRequest>(ok).is_ok());
        assert!(serde_json::from_value::<DropRouteKeysRequest>(bad).is_err());
    }

    #[test]
    fn route_keys_round_trip_as_the_rfc_8291_test_keys() {
        let keys = RouteKeys {
            p256dh: P256dhKey::try_from(P256DH.to_owned()).expect("valid key"),
            auth: AuthSecret::try_from(AUTH.to_owned()).expect("valid secret"),
        };
        let value = json!({ "p256dh": P256DH, "auth": AUTH });

        assert_eq!(serde_json::to_value(&keys).expect("serializes"), value);
        assert_eq!(
            serde_json::from_value::<RouteKeys>(value).expect("parses"),
            keys
        );
    }

    #[test]
    fn malformed_route_ids_are_rejected() {
        for route_id in [
            String::new(),
            "a/b".to_owned(),
            "a=".to_owned(),
            "a".repeat(65),
        ] {
            assert_eq!(RouteId::try_from(route_id), Err(InvalidValue::RouteId));
        }
    }

    #[test]
    fn keys_of_the_wrong_length_or_alphabet_are_rejected() {
        for key in [
            &P256DH[1..],
            &P256DH.replacen('B', "A", 1),
            &P256DH.replacen('_', "/", 1),
        ] {
            assert_eq!(
                P256dhKey::try_from(key.to_owned()),
                Err(InvalidValue::P256dhKey)
            );
        }
        for secret in [&AUTH[1..], &format!("{AUTH}A"), &AUTH.replacen('_', "+", 1)] {
            assert_eq!(
                AuthSecret::try_from(secret.to_owned()),
                Err(InvalidValue::AuthSecret)
            );
        }
    }
}
