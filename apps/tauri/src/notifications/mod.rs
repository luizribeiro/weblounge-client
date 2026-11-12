//! The native half of the page's `Notification` API.

#[cfg(target_os = "macos")]
mod center;
mod model;
mod service;

use std::sync::Arc;

use tauri::State;

use model::Permission;
use service::{NotificationError, Service};

pub fn service() -> Arc<Service> {
    Arc::new(Service::new(system_center()))
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
