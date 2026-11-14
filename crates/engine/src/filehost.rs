/// Returns the ASCII origin of the file host the network advertises, if any.
pub(crate) fn origin(state: &papo::State) -> Option<String> {
    state.filehost().and_then(https_origin)
}

use crate::upload_policy::Address;

/// The advertised upload URL, with the authority and address the credential rules compare.
pub(crate) struct UploadEndpoint {
    pub(crate) url: String,
    pub(crate) authority: String,
    pub(crate) address: Address,
}

pub(crate) fn upload_endpoint(state: &papo::State) -> Option<UploadEndpoint> {
    upload_endpoint_from(state.filehost()?)
}

// The password follows whatever host this parse names, while the browser parses the URL itself,
// so only authorities both read the same way are accepted: plain host names, IPv6 literals and
// ports, with no credentials or percent-escapes.
fn upload_endpoint_from(url: &str) -> Option<UploadEndpoint> {
    let raw = url
        .strip_prefix("https://")?
        .split(['/', '?', '#'])
        .next()?;
    if !raw
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b".-:[]".contains(&byte))
    {
        return None;
    }
    let authority = https_origin(url)?.strip_prefix("https://")?.to_owned();
    Some(UploadEndpoint {
        url: url.to_owned(),
        address: address_of(&authority, 443)?,
        authority,
    })
}

/// The lowercase host and port of a `ws://` or `wss://` connection endpoint.
pub(crate) fn endpoint_address(endpoint: &str) -> Option<Address> {
    let (rest, default_port) = endpoint
        .strip_prefix("wss://")
        .map(|rest| (rest, 443))
        .or_else(|| endpoint.strip_prefix("ws://").map(|rest| (rest, 80)))?;
    let address = address_of(&authority(rest).to_ascii_lowercase(), default_port)?;
    (!address.host.is_empty()).then_some(address)
}

fn address_of(authority: &str, default_port: u16) -> Option<Address> {
    let host = host_of(authority);
    let port = match &authority[host.len()..] {
        "" => default_port,
        explicit => explicit.strip_prefix(':')?.parse().ok()?,
    };
    Some(Address {
        host: host.to_owned(),
        port,
    })
}

fn https_origin(url: &str) -> Option<String> {
    let host = authority(url.strip_prefix("https://")?);
    let host = host.strip_suffix(":443").unwrap_or(host);
    is_plain_ascii_host(host).then(|| format!("https://{}", host.to_ascii_lowercase()))
}

fn authority(after_scheme: &str) -> &str {
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host)
}

fn host_of(authority: &str) -> &str {
    if authority.starts_with('[') {
        return authority
            .find(']')
            .map_or(authority, |end| &authority[..=end]);
    }
    authority
        .rsplit_once(':')
        .map_or(authority, |(host, _)| host)
}

// Browsers compare punycode origins; a host they would rewrite can never match, so it is refused.
fn is_plain_ascii_host(host: &str) -> bool {
    !host.is_empty()
        && !host.ends_with(':')
        && host
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && byte != b'\\')
}

#[cfg(test)]
mod tests {
    use super::{endpoint_address, host_of, https_origin, upload_endpoint_from};
    use crate::upload_policy::Address;

    #[test]
    fn upload_endpoints_keep_the_authority_the_browser_will_use() {
        let endpoint =
            upload_endpoint_from("https://Files.Example.org:8443/upload?x=1").expect("valid");
        assert_eq!(endpoint.url, "https://Files.Example.org:8443/upload?x=1");
        assert_eq!(endpoint.authority, "files.example.org:8443");
        assert_eq!(endpoint.address.host, "files.example.org");
        assert_eq!(endpoint.address.port, 8443);
        for url in [
            "https://files.example.org:443/upload",
            "https://files.example.org/upload",
        ] {
            let default_port = upload_endpoint_from(url).expect("valid");
            assert_eq!(default_port.authority, "files.example.org", "{url}");
            assert_eq!(default_port.address.port, 443, "{url}");
        }
        let ipv6 = upload_endpoint_from("https://[::1]:9443/upload").expect("valid");
        assert_eq!(
            (ipv6.address.host.as_str(), ipv6.address.port),
            ("[::1]", 9443)
        );
    }

    #[test]
    fn upload_endpoints_refuse_authorities_parsers_could_read_differently() {
        for url in [
            "https://user:pw@files.example.org/upload",
            "https://irc.example.org@files.attacker.test/upload",
            "https://[::1]@files.attacker.test/upload",
            "https://files%2eattacker.test/upload",
            "https://files.example.org%2f@attacker.test/upload",
            "https://files.example.org\\@attacker.test/upload",
            "https://files .example.org/upload",
            "https://files.example.org\t/upload",
            "http://files.example.org/upload",
        ] {
            assert!(upload_endpoint_from(url).is_none(), "{url}");
        }
    }

    #[test]
    fn endpoint_addresses_default_their_port_by_scheme() {
        let at = |host: &str, port| {
            Some(Address {
                host: host.into(),
                port,
            })
        };
        for (endpoint, expected) in [
            ("wss://IRC.Example.org/socket", at("irc.example.org", 443)),
            ("ws://127.0.0.1:4173/socket", at("127.0.0.1", 4173)),
            ("ws://irc.example.org/socket", at("irc.example.org", 80)),
            (
                "wss://user:pw@irc.example.org:8097",
                at("irc.example.org", 8097),
            ),
            ("wss://[::1]:8097/socket", at("[::1]", 8097)),
            ("wss://irc.example.org:notaport/socket", None),
            ("https://irc.example.org", None),
            ("wss:///socket", None),
        ] {
            assert_eq!(endpoint_address(endpoint), expected, "{endpoint}");
        }
    }

    #[test]
    fn host_of_keeps_bracketed_ipv6() {
        assert_eq!(host_of("files.example.net:8443"), "files.example.net");
        assert_eq!(host_of("files.example.net"), "files.example.net");
        assert_eq!(host_of("[::1]:9443"), "[::1]");
        assert_eq!(host_of("[::1]"), "[::1]");
    }

    #[test]
    fn origin_keeps_scheme_host_and_non_default_port() {
        assert_eq!(
            https_origin("https://Files.Example.test:8443/upload?x=1").as_deref(),
            Some("https://files.example.test:8443")
        );
        assert_eq!(
            https_origin("https://files.example.test:443/upload").as_deref(),
            Some("https://files.example.test")
        );
        assert_eq!(
            https_origin("https://user:secret@files.example.test").as_deref(),
            Some("https://files.example.test")
        );
        assert_eq!(
            https_origin("https://[::1]:9443/upload").as_deref(),
            Some("https://[::1]:9443")
        );
        assert_eq!(
            https_origin("https://files.example.test:1443").as_deref(),
            Some("https://files.example.test:1443")
        );
    }

    #[test]
    fn origin_rejects_hosts_a_browser_would_not_match() {
        for url in [
            "http://files.example.test/upload",
            "https:///upload",
            "https://files.example.test:/upload",
            "https://fïles.example.test/upload",
            "https://files.example.test\\upload",
        ] {
            assert_eq!(https_origin(url), None, "{url}");
        }
    }
}
