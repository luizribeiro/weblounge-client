//! What the page sends and receives, independent of any notification backend.

use serde::Serialize;

const MAX_ID_CHARS: usize = 256;
const MAX_TITLE_CHARS: usize = 256;
const MAX_BODY_CHARS: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    Granted,
    Denied,
    Default,
}

impl Permission {
    pub fn from_grant(granted: bool) -> Self {
        if granted { Self::Granted } else { Self::Denied }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("notification id must be 1 to {MAX_ID_CHARS} characters")]
pub struct InvalidId;

pub struct Notification<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub body: &'a str,
}

impl<'a> Notification<'a> {
    pub fn from_page(
        id: &'a str,
        title: &'a str,
        body: Option<&'a str>,
    ) -> Result<Self, InvalidId> {
        Ok(Self {
            id: validated_id(id)?,
            title: truncated(title, MAX_TITLE_CHARS),
            body: truncated(body.unwrap_or_default(), MAX_BODY_CHARS),
        })
    }
}

pub fn validated_id(id: &str) -> Result<&str, InvalidId> {
    if id.is_empty() || id.chars().count() > MAX_ID_CHARS {
        Err(InvalidId)
    } else {
        Ok(id)
    }
}

fn truncated(text: &str, max_chars: usize) -> &str {
    text.char_indices()
        .nth(max_chars)
        .map_or(text, |(end, _)| &text[..end])
}

pub fn click_script(id: &str) -> Result<String, serde_json::Error> {
    Ok(format!(
        "window.__weblounge_notifications?.click({});",
        serde_json::to_string(id)?
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_grant_flag_maps_to_granted_or_denied() {
        assert_eq!(Permission::from_grant(true), Permission::Granted);
        assert_eq!(Permission::from_grant(false), Permission::Denied);
    }

    #[test]
    fn permissions_serialize_as_the_pages_strings() {
        let serialized: Vec<String> =
            [Permission::Granted, Permission::Denied, Permission::Default]
                .iter()
                .map(|permission| serde_json::to_string(permission).expect("serializes"))
                .collect();
        assert_eq!(serialized, [r#""granted""#, r#""denied""#, r#""default""#]);
    }

    #[test]
    fn ids_must_be_short_and_not_empty() {
        assert!(validated_id("libera/#rust").is_ok());
        assert!(validated_id(&"é".repeat(MAX_ID_CHARS)).is_ok());
        assert!(validated_id("").is_err());
        assert!(validated_id(&"x".repeat(MAX_ID_CHARS + 1)).is_err());
    }

    #[test]
    fn long_titles_and_bodies_are_truncated_on_character_boundaries() {
        let title = "é".repeat(MAX_TITLE_CHARS + 10);
        let body = "日".repeat(MAX_BODY_CHARS + 10);
        let notification = Notification::from_page("t", &title, Some(&body)).expect("valid");
        assert_eq!(notification.title.chars().count(), MAX_TITLE_CHARS);
        assert_eq!(notification.body.chars().count(), MAX_BODY_CHARS);
    }

    #[test]
    fn short_text_and_a_missing_body_are_kept() {
        let notification = Notification::from_page("t", "#rust", None).expect("valid");
        assert_eq!(notification.title, "#rust");
        assert_eq!(notification.body, "");
    }

    #[test]
    fn click_script_escapes_the_id_as_a_string_literal() {
        let script = click_script(r#"x"); alert(1); ("#).expect("id serializes");
        assert_eq!(
            script,
            r#"window.__weblounge_notifications?.click("x\"); alert(1); (");"#
        );
    }
}
