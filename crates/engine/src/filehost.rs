/// Returns the ASCII origin of the file host the network advertises, if any.
pub(crate) fn origin(state: &papo::State) -> Option<String> {
    state.filehost().and_then(https_origin)
}

fn https_origin(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = host.strip_suffix(":443").unwrap_or(host);
    is_plain_ascii_host(host).then(|| format!("https://{}", host.to_ascii_lowercase()))
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
    use super::https_origin;

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
