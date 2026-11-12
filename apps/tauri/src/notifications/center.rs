//! The system notification center; the only place that talks to Objective-C.
#![allow(unsafe_code)]

use std::{
    ptr::NonNull,
    sync::{OnceLock, mpsc},
    time::Duration,
};

use block2::{DynBlock, RcBlock};
use objc2::{
    MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::{Retained, autoreleasepool},
    runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject},
};
use objc2_foundation::{NSArray, NSBundle, NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};

use super::{
    model::{Notification, Permission},
    service::{CenterError, NotificationCenter, answer_within},
};
use crate::window::log_failure;

const QUICK_ANSWER: Duration = Duration::from_secs(5);
const PERMISSION_PROMPT_ANSWER: Duration = Duration::from_secs(300);

#[allow(dead_code)]
type ClickHandler = Box<dyn Fn(String) + Send + Sync>;

#[allow(dead_code)]
static CLICK_HANDLER: OnceLock<ClickHandler> = OnceLock::new();

pub struct SystemCenter;

impl SystemCenter {
    pub fn permission_within(timeout: Duration) -> Result<Permission, CenterError> {
        with_center(|center| {
            let (send, answers) = mpsc::channel();
            let answer = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
                let status = unsafe { settings.as_ref() }.authorizationStatus();
                let _ = send.send(permission_for(status));
            });
            center.getNotificationSettingsWithCompletionHandler(&answer);
            answer_within(&answers, timeout)
        })
    }
}

impl NotificationCenter for SystemCenter {
    fn permission(&self) -> Result<Permission, CenterError> {
        Self::permission_within(QUICK_ANSWER)
    }

    fn request_permission(&self) -> Result<Permission, CenterError> {
        with_center(|center| {
            let (send, answers) = mpsc::channel();
            let answer = RcBlock::new(move |granted: Bool, error: *mut NSError| {
                let _ = send.send(match error_message(error) {
                    Some(message) => Err(message),
                    None => Ok(Permission::from_grant(granted.as_bool())),
                });
            });
            let options = UNAuthorizationOptions::Alert
                | UNAuthorizationOptions::Sound
                | UNAuthorizationOptions::Badge;
            center.requestAuthorizationWithOptions_completionHandler(options, &answer);
            answer_within(&answers, PERMISSION_PROMPT_ANSWER)?.map_err(CenterError::Refused)
        })
    }

    fn post(&self, notification: &Notification) -> Result<(), CenterError> {
        with_center(|center| {
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(notification.title));
            content.setBody(&NSString::from_str(notification.body));
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSString::from_str(notification.id),
                &content,
                None,
            );
            let (send, answers) = mpsc::channel();
            let answer = RcBlock::new(move |error: *mut NSError| {
                let _ = send.send(error_message(error));
            });
            center.addNotificationRequest_withCompletionHandler(&request, Some(&answer));
            match answer_within(&answers, QUICK_ANSWER)? {
                Some(message) => Err(CenterError::Refused(message)),
                None => Ok(()),
            }
        })
    }

    fn remove(&self, id: &str) {
        log_failure(
            "remove a notification",
            with_center(|center| {
                let ids = NSArray::from_retained_slice(&[NSString::from_str(id)]);
                center.removeDeliveredNotificationsWithIdentifiers(&ids);
                center.removePendingNotificationRequestsWithIdentifiers(&ids);
                Ok(())
            }),
        );
    }
}

fn permission_for(status: UNAuthorizationStatus) -> Permission {
    if status == UNAuthorizationStatus::Denied {
        Permission::Denied
    } else if status == UNAuthorizationStatus::Authorized
        || status == UNAuthorizationStatus::Provisional
        || status == UNAuthorizationStatus::Ephemeral
    {
        Permission::Granted
    } else {
        Permission::Default
    }
}

// Asking for the center without an app bundle (an unbundled `cargo run`) raises an exception.
fn is_bundled() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

fn with_center<T>(
    work: impl FnOnce(&UNUserNotificationCenter) -> Result<T, CenterError>,
) -> Result<T, CenterError> {
    autoreleasepool(|_| {
        if !is_bundled() {
            return Err(CenterError::NoBundle);
        }
        work(&UNUserNotificationCenter::currentNotificationCenter())
    })
}

fn error_message(error: *mut NSError) -> Option<String> {
    NonNull::new(error).map(|error| unsafe { error.as_ref() }.to_string())
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "WeblounceNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    // The center calls these on the main thread, as `MainThreadOnly` requires, and a panic here
    // would unwind into Objective-C, so nothing in them may panic.
    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion
                .call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &DynBlock<dyn Fn()>,
        ) {
            let id = response.notification().request().identifier().to_string();
            if let Some(handler) = CLICK_HANDLER.get() {
                let clicked =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(id)));
                if clicked.is_err() {
                    eprintln!("the notification click handler panicked");
                }
            }
            completion.call(());
        }
    }
);

/// The center keeps only a weak reference to its delegate, so the delegate is leaked.
#[allow(dead_code)]
pub fn install_delegate(on_click: ClickHandler) {
    let Some(main_thread) = MainThreadMarker::new() else {
        eprintln!("the notification delegate must be installed on the main thread");
        return;
    };
    if !is_bundled() || CLICK_HANDLER.set(on_click).is_err() {
        return;
    }
    let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(main_thread), init] };
    autoreleasepool(|_| {
        UNUserNotificationCenter::currentNotificationCenter()
            .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    });
    std::mem::forget(delegate);
}
