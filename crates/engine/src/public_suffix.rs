use std::collections::HashSet;
use std::sync::OnceLock;

const LIST: &str = include_str!("../data/public-suffixes.txt");

struct Rules {
    exact: HashSet<&'static str>,
    wildcard_parents: HashSet<&'static str>,
    exceptions: HashSet<&'static str>,
}

fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| parse(LIST))
}

fn parse(list: &'static str) -> Rules {
    let mut rules = Rules {
        exact: HashSet::new(),
        wildcard_parents: HashSet::new(),
        exceptions: HashSet::new(),
    };
    for line in list.lines().filter(|line| !line.starts_with("//")) {
        if let Some(parent) = line.strip_prefix("*.") {
            rules.wildcard_parents.insert(parent);
        } else if let Some(exception) = line.strip_prefix('!') {
            rules.exceptions.insert(exception);
        } else {
            rules.exact.insert(line);
        }
    }
    rules
}

/// The registrable domain (public suffix plus one label) of a lowercase ASCII host name, or
/// `None` when the host is itself a public suffix.
pub(crate) fn registrable_domain(host: &str) -> Option<&str> {
    let suffix_start = public_suffix_start(host, rules());
    let label_end = suffix_start.checked_sub(1)?;
    let label_start = host[..label_end].rfind('.').map_or(0, |dot| dot + 1);
    Some(&host[label_start..])
}

fn label_starts(host: &str) -> impl Iterator<Item = usize> + '_ {
    std::iter::once(0).chain(host.match_indices('.').map(|(dot, _)| dot + 1))
}

fn parent_start(host: &str, start: usize) -> Option<usize> {
    host[start..].find('.').map(|dot| start + dot + 1)
}

// Exception rules prevail over every other match; otherwise the longest rule wins, and an
// unlisted top-level label is its own suffix (the list's implicit `*` rule).
fn public_suffix_start(host: &str, rules: &Rules) -> usize {
    if let Some(start) = label_starts(host).find(|&start| rules.exceptions.contains(&host[start..]))
    {
        return parent_start(host, start).unwrap_or(host.len());
    }
    label_starts(host)
        .find(|&start| {
            rules.exact.contains(&host[start..])
                || parent_start(host, start)
                    .is_some_and(|parent| rules.wildcard_parents.contains(&host[parent..]))
        })
        .unwrap_or_else(|| host.rfind('.').map_or(0, |dot| dot + 1))
}

#[cfg(test)]
mod tests {
    use super::registrable_domain;

    #[test]
    fn the_vendored_list_is_complete() {
        let rules = super::rules();
        assert!(rules.exact.len() > 9_000, "{}", rules.exact.len());
        assert!(rules.exact.contains("co.uk") && rules.exact.contains("github.io"));
        assert!(rules.wildcard_parents.contains("ck") && rules.exceptions.contains("www.ck"));
    }

    #[test]
    fn listed_suffixes_take_one_more_label() {
        for (host, expected) in [
            ("example.com", Some("example.com")),
            ("www.example.com", Some("example.com")),
            ("a.b.example.co.uk", Some("example.co.uk")),
            ("alice.github.io", Some("alice.github.io")),
            ("files.alice.github.io", Some("alice.github.io")),
            ("example.uk.com", Some("example.uk.com")),
        ] {
            assert_eq!(registrable_domain(host), expected, "{host}");
        }
    }

    #[test]
    fn a_public_suffix_has_no_registrable_domain() {
        for host in [
            "com",
            "co.uk",
            "github.io",
            "uk.com",
            "c.kobe.jp",
            "test.ck",
        ] {
            assert_eq!(registrable_domain(host), None, "{host}");
        }
    }

    #[test]
    fn wildcards_and_their_exceptions_follow_the_list() {
        for (host, expected) in [
            ("b.c.kobe.jp", Some("b.c.kobe.jp")),
            ("city.kobe.jp", Some("city.kobe.jp")),
            ("www.city.kobe.jp", Some("city.kobe.jp")),
            ("www.ck", Some("www.ck")),
            ("www.www.ck", Some("www.ck")),
            ("b.test.ck", Some("b.test.ck")),
        ] {
            assert_eq!(registrable_domain(host), expected, "{host}");
        }
    }

    #[test]
    fn unlisted_top_level_labels_are_their_own_suffix() {
        assert_eq!(registrable_domain("localhost"), None);
        assert_eq!(registrable_domain("irc.localhost"), Some("irc.localhost"));
        assert_eq!(
            registrable_domain("files.irc.example-unlisted"),
            Some("irc.example-unlisted")
        );
    }
}
