//! Actions the native menu asks the page to run, through the page's allow-listed
//! `weblounge:action` event (design 29 D3).

#[derive(Clone, Copy)]
pub enum PageAction {
    OpenSettings,
}

impl PageAction {
    const fn name(self) -> &'static str {
        match self {
            Self::OpenSettings => "settings.open",
        }
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
}
