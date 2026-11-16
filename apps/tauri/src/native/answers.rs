//! The Swift side's raw answers, and how each becomes the bridge type the page receives.

use serde::Deserialize;
use weblounge_native_bridge::{ApnsEnvironment, ApnsToken, PushTarget};

/// The device token and what decides its APNs host.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    token: ApnsToken,
    simulator: bool,
    profile_aps_environment: Option<String>,
}

impl Registration {
    /// A development profile, or the simulator, which has none, registers with the sandbox.
    /// App Store and `TestFlight` builds carry no embedded profile and use production.
    pub fn into_target(self) -> PushTarget {
        let sandbox =
            self.simulator || self.profile_aps_environment.as_deref() == Some("development");
        PushTarget::Apns {
            token: self.token,
            environment: if sandbox {
                ApnsEnvironment::Sandbox
            } else {
                ApnsEnvironment::Production
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const TOKEN: &str = "740f4707bebcf74f9b7c25d48e3358945f6aa01da5ddb387462c7eaf61bb78ad";

    fn environment(simulator: bool, profile: Option<&str>) -> ApnsEnvironment {
        let registration: Registration = serde_json::from_value(json!({
            "token": TOKEN,
            "simulator": simulator,
            "profileApsEnvironment": profile,
        }))
        .expect("parses");
        let PushTarget::Apns { token, environment } = registration.into_target();
        assert_eq!(token.as_str(), TOKEN);
        environment
    }

    #[test]
    fn the_profile_or_the_simulator_picks_the_apns_host() {
        assert_eq!(environment(true, None), ApnsEnvironment::Sandbox);
        assert_eq!(
            environment(false, Some("development")),
            ApnsEnvironment::Sandbox
        );
        assert_eq!(
            environment(false, Some("production")),
            ApnsEnvironment::Production
        );
        assert_eq!(environment(false, None), ApnsEnvironment::Production);
    }

    #[test]
    fn an_uppercase_or_short_token_is_rejected() {
        for token in [TOKEN.to_uppercase(), TOKEN[..10].to_owned()] {
            let answer =
                json!({ "token": token, "simulator": true, "profileApsEnvironment": null });
            assert!(serde_json::from_value::<Registration>(answer).is_err());
        }
    }
}
