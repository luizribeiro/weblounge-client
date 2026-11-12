//! The native half of the page's `Notification` API.

#[cfg(target_os = "macos")]
mod center;
mod model;
mod service;

use std::{sync::Arc, time::Duration};

use tauri::{AppHandle, State};

use crate::window;
use model::{Permission, click_script};
use service::{CenterError, NotificationError, Service};

const STARTUP_PERMISSION_ANSWER: Duration = Duration::from_secs(1);
const INITIAL_PERMISSION_GLOBAL: &str = "__weblounge_initial_permission";

pub fn service() -> Arc<Service> {
    Arc::new(Service::new(system_center()))
}

pub fn initial_permission() -> Permission {
    startup_permission().unwrap_or_else(|error| {
        window::log_failure("read the notification permission", Err::<(), _>(error));
        Permission::Default
    })
}

pub fn init_script(permission: Permission) -> Result<String, serde_json::Error> {
    Ok(format!(
        "window.{INITIAL_PERMISSION_GLOBAL} = {};\n{}",
        serde_json::to_string(&permission)?,
        include_str!("../notification.js")
    ))
}

#[cfg(target_os = "macos")]
pub fn install_click_delegate(app: &AppHandle) {
    let app = app.clone();
    center::install_delegate(Box::new(move |id| {
        window::show(&app);
        match click_script(&id) {
            Ok(script) => window::eval_in_page(&app, &script),
            Err(error) => window::log_failure("build the click script", Err::<(), _>(error)),
        }
    }));
}

#[cfg(not(target_os = "macos"))]
pub fn install_click_delegate(_app: &AppHandle) {}

#[cfg(target_os = "macos")]
fn startup_permission() -> Result<Permission, CenterError> {
    center::SystemCenter::permission_within(STARTUP_PERMISSION_ANSWER)
}

#[cfg(not(target_os = "macos"))]
fn startup_permission() -> Result<Permission, CenterError> {
    Err(CenterError::NoBundle)
}

#[cfg(target_os = "macos")]
fn system_center() -> Arc<dyn service::NotificationCenter> {
    Arc::new(center::SystemCenter)
}

#[cfg(not(target_os = "macos"))]
fn system_center() -> Arc<dyn service::NotificationCenter> {
    struct Unavailable;

    impl service::NotificationCenter for Unavailable {
        fn permission(&self) -> Result<Permission, service::CenterError> {
            Err(service::CenterError::NoBundle)
        }

        fn request_permission(&self) -> Result<Permission, service::CenterError> {
            Err(service::CenterError::NoBundle)
        }

        fn post(&self, _: &model::Notification) -> Result<(), service::CenterError> {
            Err(service::CenterError::NoBundle)
        }

        fn remove(&self, _: &str) {}
    }

    Arc::new(Unavailable)
}

async fn run_blocking<T: Send + 'static>(
    service: State<'_, Arc<Service>>,
    work: impl FnOnce(&Service) -> Result<T, NotificationError> + Send + 'static,
) -> Result<T, NotificationError> {
    let service = Arc::clone(&service);
    tauri::async_runtime::spawn_blocking(move || work(&service)).await?
}

#[tauri::command]
pub async fn notification_permission(
    service: State<'_, Arc<Service>>,
) -> Result<Permission, NotificationError> {
    run_blocking(service, Service::permission).await
}

#[tauri::command]
pub async fn request_notification_permission(
    service: State<'_, Arc<Service>>,
) -> Result<Permission, NotificationError> {
    run_blocking(service, Service::request_permission).await
}

#[tauri::command]
pub async fn post_notification(
    service: State<'_, Arc<Service>>,
    id: String,
    title: String,
    body: Option<String>,
) -> Result<(), NotificationError> {
    run_blocking(service, move |service| {
        service.post(&id, &title, body.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn close_notification(
    service: State<'_, Arc<Service>>,
    id: String,
) -> Result<(), NotificationError> {
    run_blocking(service, move |service| service.close(&id)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_script_defines_the_permission_then_the_whole_shim() {
        for (permission, literal) in [
            (Permission::Granted, "granted"),
            (Permission::Denied, "denied"),
            (Permission::Default, "default"),
        ] {
            let script = init_script(permission).expect("script builds");
            let expected = format!(
                "window.__weblounge_initial_permission = \"{literal}\";\n{}",
                include_str!("../notification.js")
            );
            assert_eq!(script, expected);
        }
    }

    #[test]
    fn the_shim_reads_the_global_the_script_defines() {
        assert!(include_str!("../notification.js").contains(INITIAL_PERMISSION_GLOBAL));
    }
}
