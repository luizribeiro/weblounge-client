//! When the engine may hand the connection's credential to the network's file host (design 31, U1).

use crate::public_suffix::registrable_domain;

/// The HTTP authorization the connection's SASL mechanism maps to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CredentialKind {
    /// SASL PLAIN's account and password, sent as HTTP Basic.
    Basic,
    /// A fresh deployment-minted token, sent as HTTP Bearer.
    Bearer,
}

/// Whether the user approved sending the credential to this exact file host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Approval {
    Absent,
    Granted,
}

/// A lowercase host and the port a connection to it uses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Address {
    pub(crate) host: String,
    pub(crate) port: u16,
}

const HTTPS_PORT: u16 = 443;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Release {
    Send,
    Ask,
    /// Never offered: a token is not something a user can meaningfully approve for a stranger.
    Refuse,
}

// The password goes unasked only to the IRC server's own host and port, or to the default HTTPS
// port of its site: another port on the site may be another service.
pub(crate) fn release_credential(
    irc: &Address,
    filehost: &Address,
    credential: CredentialKind,
    approval: Approval,
) -> Release {
    let site = same_site(&irc.host, &filehost.host);
    match (credential, approval) {
        (CredentialKind::Bearer, _) if site => Release::Send,
        (CredentialKind::Bearer, _) => Release::Refuse,
        (CredentialKind::Basic, Approval::Granted) => Release::Send,
        (CredentialKind::Basic, Approval::Absent)
            if same_service(irc, filehost) || (site && filehost.port == HTTPS_PORT) =>
        {
            Release::Send
        }
        (CredentialKind::Basic, Approval::Absent) => Release::Ask,
    }
}

fn same_service(first: &Address, second: &Address) -> bool {
    let host = normalize(&first.host);
    !host.is_empty() && host == normalize(&second.host) && first.port == second.port
}

/// Equal hosts, or host names sharing one registrable domain by the Public Suffix List.
pub(crate) fn same_site(first: &str, second: &str) -> bool {
    let (first, second) = (normalize(first), normalize(second));
    if first.is_empty() || second.is_empty() {
        return false;
    }
    first == second
        || site(&first)
            .zip(site(&second))
            .is_some_and(|(first, second)| first == second)
}

fn normalize(host: &str) -> String {
    let host = host.to_ascii_lowercase();
    host.strip_suffix('.').unwrap_or(&host).to_owned()
}

fn site(host: &str) -> Option<&str> {
    is_comparable_name(host)
        .then(|| registrable_domain(host))
        .flatten()
}

// IP-like hosts (no TLD starts with a non-letter), punycode labels (the vendored list keeps only
// ASCII rules, so an internationalized suffix would be missed) and malformed names only ever
// match themselves.
fn is_comparable_name(host: &str) -> bool {
    host.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'.')
        && host
            .rsplit('.')
            .next()
            .is_some_and(|label| label.starts_with(|c: char| c.is_ascii_alphabetic()))
        && host
            .split('.')
            .all(|label| !label.is_empty() && !label.starts_with("xn--"))
}

#[cfg(test)]
mod tests {
    use super::{Address, Approval, CredentialKind, Release, release_credential, same_site};

    fn at(host: &str, port: u16) -> Address {
        Address {
            host: host.into(),
            port,
        }
    }

    #[test]
    fn bearer_goes_only_to_its_own_site_whatever_the_approval() {
        for (irc, filehost, expected) in [
            ("beta.weblounge.org", "files.weblounge.org", Release::Send),
            ("beta.weblounge.org", "beta.weblounge.org", Release::Send),
            ("beta.weblounge.org", "files.attacker.test", Release::Refuse),
            ("alice.github.io", "bob.github.io", Release::Refuse),
            ("127.0.0.1", "localhost", Release::Refuse),
        ] {
            for approval in [Approval::Absent, Approval::Granted] {
                assert_eq!(
                    release_credential(
                        &at(irc, 443),
                        &at(filehost, 443),
                        CredentialKind::Bearer,
                        approval
                    ),
                    expected,
                    "{irc} {filehost} {approval:?}"
                );
            }
        }
    }

    #[test]
    fn basic_goes_to_its_own_site_and_asks_elsewhere() {
        for (irc, filehost, expected) in [
            ("irc.example.org", "files.example.org", Release::Send),
            ("example.org", "files.example.org", Release::Send),
            ("irc.example.org", "files.example.net", Release::Ask),
            ("irc.example.org", "example.org.attacker.test", Release::Ask),
            ("irc.example.co.uk", "files.example.co.uk", Release::Send),
            ("irc.example.co.uk", "files.other.co.uk", Release::Ask),
        ] {
            assert_eq!(
                release_credential(
                    &at(irc, 443),
                    &at(filehost, 443),
                    CredentialKind::Basic,
                    Approval::Absent
                ),
                expected,
                "{irc} {filehost}"
            );
        }
    }

    #[test]
    fn an_approval_releases_basic_anywhere() {
        assert_eq!(
            release_credential(
                &at("irc.example.org", 443),
                &at("files.attacker.test", 8443),
                CredentialKind::Basic,
                Approval::Granted,
            ),
            Release::Send
        );
    }

    #[test]
    fn basic_goes_unasked_only_to_the_default_https_port_or_the_irc_service_itself() {
        for (irc, filehost, expected) in [
            (
                at("irc.example.org", 443),
                at("files.example.org", 443),
                Release::Send,
            ),
            (
                at("irc.example.org", 6697),
                at("files.example.org", 443),
                Release::Send,
            ),
            (
                at("irc.example.org", 443),
                at("files.example.org", 9999),
                Release::Ask,
            ),
            (
                at("irc.example.org", 443),
                at("irc.example.org", 9999),
                Release::Ask,
            ),
            (
                at("irc.example.org", 8097),
                at("IRC.example.org.", 8097),
                Release::Send,
            ),
            (at("127.0.0.1", 4175), at("127.0.0.1", 4175), Release::Send),
            (at("127.0.0.1", 4173), at("127.0.0.1", 4175), Release::Ask),
            (
                at("irc.example.org", 8097),
                at("files.example.net", 8097),
                Release::Ask,
            ),
            (at("", 443), at("", 443), Release::Ask),
        ] {
            assert_eq!(
                release_credential(&irc, &filehost, CredentialKind::Basic, Approval::Absent),
                expected,
                "{irc:?} {filehost:?}"
            );
        }
    }

    #[test]
    fn private_suffixes_separate_their_tenants() {
        assert!(!same_site("alice.github.io", "bob.github.io"));
        assert!(same_site("irc.alice.github.io", "files.alice.github.io"));
        assert!(!same_site("github.io", "alice.github.io"));
    }

    #[test]
    fn ip_like_hosts_match_only_themselves() {
        for (first, second, expected) in [
            ("127.0.0.1", "127.0.0.1", true),
            ("127.0.0.1", "127.0.0.2", false),
            ("10.0.0.1", "1.0.0.1", false),
            ("0x7f.1", "1.0x7f.1", false),
            ("2130706433", "2130706433", true),
            ("[::1]", "[::1]", true),
            ("[::1]", "[::2]", false),
            ("127.0.0.1", "localhost", false),
        ] {
            assert_eq!(same_site(first, second), expected, "{first} {second}");
        }
    }

    #[test]
    fn names_without_a_registrable_domain_match_only_themselves() {
        assert!(same_site("localhost", "localhost"));
        assert!(!same_site("localhost", "files.localhost"));
        assert!(same_site("irc.localhost", "files.irc.localhost"));
        assert!(!same_site("co.uk", "example.co.uk"));
        assert!(!same_site("c.kobe.jp", "d.kobe.jp"));
    }

    #[test]
    fn punycode_and_malformed_names_match_only_themselves() {
        for (first, second, expected) in [
            ("irc.xn--p1ai", "files.xn--p1ai", false),
            (
                "irc.xn--bcher-kva.example",
                "files.xn--bcher-kva.example",
                false,
            ),
            ("irc.xn--p1ai", "irc.xn--p1ai", true),
            ("a..example.org", "b.example.org", false),
            ("irc.example.org", "files.example.org:443", false),
            ("irc.example.org", "", false),
            ("", "", false),
        ] {
            assert_eq!(same_site(first, second), expected, "{first} {second}");
        }
    }

    #[test]
    fn case_and_one_trailing_dot_are_ignored() {
        assert!(same_site("IRC.Example.ORG", "files.example.org."));
        assert!(same_site("irc.example.org.", "irc.example.org"));
        assert!(!same_site("irc.example.org..", "files.example.org"));
    }
}
