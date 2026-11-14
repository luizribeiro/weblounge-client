//! Actions the native menu asks the page to run, through the page's allow-listed
//! `weblounge:action` event (design 29 D3). Each action's name doubles as its menu item id.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageAction {
    OpenSettings,
    NextBuffer,
    PreviousBuffer,
}

impl PageAction {
    pub const ALL: [Self; 3] = [Self::OpenSettings, Self::NextBuffer, Self::PreviousBuffer];

    pub const fn name(self) -> &'static str {
        match self {
            Self::OpenSettings => "settings.open",
            Self::NextBuffer => "buffer.next",
            Self::PreviousBuffer => "buffer.previous",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::OpenSettings => "Settings…",
            Self::NextBuffer => "Next Conversation",
            Self::PreviousBuffer => "Previous Conversation",
        }
    }

    pub const fn accelerator(self) -> &'static str {
        match self {
            Self::OpenSettings => "CmdOrCtrl+,",
            Self::NextBuffer => "Ctrl+Tab",
            Self::PreviousBuffer => "Ctrl+Shift+Tab",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|action| action.name() == name)
    }
}

pub fn dispatch_script(action: PageAction) -> String {
    format!(
        "window.dispatchEvent(new CustomEvent(\"weblounge:action\", {{ detail: \"{}\" }}));",
        action.name()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_settings_dispatches_the_page_contract_event() {
        assert_eq!(
            dispatch_script(PageAction::OpenSettings),
            "window.dispatchEvent(new CustomEvent(\"weblounge:action\", \
             { detail: \"settings.open\" }));"
        );
    }

    #[test]
    fn menu_ids_resolve_to_their_actions() {
        for action in PageAction::ALL {
            assert_eq!(PageAction::from_name(action.name()), Some(action));
        }
        assert_eq!(
            PageAction::from_name("buffer.next"),
            Some(PageAction::NextBuffer)
        );
        assert_eq!(PageAction::from_name("reload"), None);
        assert_eq!(PageAction::from_name("open-at-login"), None);
    }
}
