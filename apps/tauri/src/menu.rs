//! The standard macOS menu bar.

use tauri::{
    AppHandle, Manager, Wry,
    menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
};
use tauri_plugin_autostart::ManagerExt;

use crate::{
    login_item,
    page_action::{self, PageAction},
    window,
};

const RELOAD_ID: &str = "reload";
const LOGIN_ID: &str = "open-at-login";

pub struct LoginCheck(CheckMenuItem<Wry>);

pub fn build(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let opens_at_login = login_item::current(&*app.autolaunch());
    let login = CheckMenuItem::with_id(
        app,
        LOGIN_ID,
        "Open at Login",
        true,
        opens_at_login,
        None::<&str>,
    )?;
    app.manage(LoginCheck(login.clone()));
    let reload = MenuItem::with_id(app, RELOAD_ID, "Reload", true, Some("CmdOrCtrl+R"))?;
    let settings = page_action_item(app, PageAction::OpenSettings)?;
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                &app.package_info().name,
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &settings,
                    &login,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&reload, &PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &page_action_item(app, PageAction::NextBuffer)?,
                    &page_action_item(app, PageAction::PreviousBuffer)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
        ],
    )
}

pub fn handle_event(app: &AppHandle, event: &MenuEvent) {
    if event.id() == RELOAD_ID {
        window::reload(app);
    } else if event.id() == LOGIN_ID {
        toggle_login_item(app);
    } else if let Some(action) = PageAction::from_name(event.id().as_ref()) {
        run_in_page(app, action);
    }
}

fn page_action_item(app: &AppHandle, action: PageAction) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(
        app,
        action.name(),
        action.label(),
        true,
        Some(action.accelerator()),
    )
}

fn run_in_page(app: &AppHandle, action: PageAction) {
    window::show(app);
    window::eval_in_page(app, &page_action::dispatch_script(action));
}

fn toggle_login_item(app: &AppHandle) {
    let manager = app.autolaunch();
    let opens_at_login = login_item::toggle(&*manager).unwrap_or_else(|error| {
        eprintln!("{error}");
        login_item::current(&*manager)
    });
    if let Err(error) = app.state::<LoginCheck>().0.set_checked(opens_at_login) {
        eprintln!("could not update the Open at Login check: {error}");
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn every_menu_item_id_is_distinct() {
        let ids: Vec<&str> = [RELOAD_ID, LOGIN_ID]
            .into_iter()
            .chain(PageAction::ALL.map(PageAction::name))
            .collect();
        assert_eq!(ids.iter().collect::<HashSet<_>>().len(), ids.len());
    }
}
