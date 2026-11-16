/// A string that failed its type's invariant while crossing the bridge.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum InvalidValue {
    /// Not at least 64 lowercase hex digits in pairs.
    #[error("APNs device token must be at least 64 lowercase hex digits, in pairs")]
    ApnsToken,
}

/// Declares a string newtype whose only constructor checks `$valid`, including when serde
/// deserializes it, so a value the page or shell receives already holds the invariant. A
/// failure is the [`InvalidValue`] variant named like the type.
macro_rules! validated_string {
    ($(#[$meta:meta])* $name:ident, $valid:path) => {
        $(#[$meta])*
        #[derive(Clone, Debug, Eq, Hash, PartialEq, serde::Serialize, ts_rs::TS)]
        pub struct $name(String);

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = <String as serde::Deserialize>::deserialize(deserializer)?;
                Self::try_from(value).map_err(serde::de::Error::custom)
            }
        }

        impl $name {
            /// The validated text.
            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl TryFrom<String> for $name {
            type Error = $crate::InvalidValue;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                if $valid(&value) {
                    Ok(Self(value))
                } else {
                    Err($crate::InvalidValue::$name)
                }
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}

pub(crate) use validated_string;
