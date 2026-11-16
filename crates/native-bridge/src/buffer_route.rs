use crate::validated::validated_string;

validated_string!(
    /// A same-origin buffer path such as `/Libera/%23weblounge` or `/Libera/@mel`, in the form
    /// the page's `bufferPath` builds, or `/` for the chat list, where the service worker's
    /// generic notifications open. The shell appends it to the hosted origin for a cold
    /// launch, so anything that could leave the path (a query, a fragment, a dot segment or
    /// another origin) is rejected.
    BufferRoutePath,
    is_buffer_route
);

fn is_buffer_route(value: &str) -> bool {
    value == "/" || is_conversation_route(value)
}

fn is_conversation_route(value: &str) -> bool {
    let Some(path) = value.strip_prefix('/') else {
        return false;
    };
    let mut segments = path.split('/');
    let (Some(network), destination, None) = (segments.next(), segments.next(), segments.next())
    else {
        return false;
    };
    is_segment(network)
        && destination.is_none_or(|destination| {
            is_segment(destination.strip_prefix('@').unwrap_or(destination))
        })
}

fn is_segment(segment: &str) -> bool {
    segment.bytes().all(is_component_byte)
        && percent_decoded(segment).is_some_and(|decoded| {
            !matches!(decoded.as_slice(), b"" | b"." | b"..") && String::from_utf8(decoded).is_ok()
        })
}

/// The bytes `encodeURIComponent` leaves unescaped, plus `%` for its escapes.
fn is_component_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"-_.!~*'()%".contains(&byte)
}

fn percent_decoded(segment: &str) -> Option<Vec<u8>> {
    let mut bytes = segment.bytes();
    let mut decoded = Vec::with_capacity(segment.len());
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let high = hex_value(bytes.next()?)?;
            let low = hex_value(bytes.next()?)?;
            decoded.push((high << 4) | low);
        } else {
            decoded.push(byte);
        }
    }
    Some(decoded)
}

fn hex_value(digit: u8) -> Option<u8> {
    char::from(digit)
        .to_digit(16)
        .and_then(|value| u8::try_from(value).ok())
}

#[cfg(test)]
mod tests {
    use super::BufferRoutePath;
    use crate::InvalidValue;

    #[test]
    fn root_server_channel_and_direct_routes_are_accepted() {
        for route in [
            "/",
            "/Libera",
            "/Libera/weblounge",
            "/Libera/%26local",
            "/Libera/@mel",
            "/Libera/@%5Bmel%5D",
            "/My%20Network/caf%C3%A9",
        ] {
            let parsed = BufferRoutePath::try_from(route.to_owned()).expect(route);
            assert_eq!(parsed.as_str(), route);
        }
    }

    #[test]
    fn paths_that_could_leave_the_buffer_route_are_rejected() {
        for route in [
            "",
            "//",
            "Libera/weblounge",
            "//evil.example/x",
            "https://evil.example/Libera",
            "/Libera/",
            "/Libera//weblounge",
            "/Libera/weblounge/extra",
            "/Libera/weblounge?x=1",
            "/Libera/weblounge#top",
            "/Libera/..",
            "/./weblounge",
            "/Libera/%2e%2e",
            "/%2E/weblounge",
            "/Libera/.%2e",
            "/Libera/@%2e.",
            "/Libera/@",
            "/@mel",
            "/Libera/a@b",
            "/Libera/%2",
            "/Libera/%zz",
            "/Libera/%FF",
            "/Libera/caf\u{e9}",
            "/Libera\\weblounge",
        ] {
            assert_eq!(
                BufferRoutePath::try_from(route.to_owned()),
                Err(InvalidValue::BufferRoutePath),
                "{route:?}"
            );
        }
    }

    #[test]
    fn deserializing_applies_the_same_check() {
        assert!(serde_json::from_str::<BufferRoutePath>("\"/Libera/@mel\"").is_ok());
        assert!(serde_json::from_str::<BufferRoutePath>("\"/Libera/x?y\"").is_err());
    }
}
