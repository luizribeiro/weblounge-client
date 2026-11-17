//! The contract between the hosted page and the iOS shell (design 33).
//!
//! The page calls the shell through Tauri `invoke` with a [`NativeCommand`] name, and the shell
//! answers with the command's result or a [`NativeBridgeError`]. The shell talks back through page
//! events. Every shape crosses the boundary as JSON and is defined here once; the page's
//! TypeScript is generated from these types.
//!
//! A command that takes input takes exactly one argument named `request`, whose type is the
//! command's `…Request` struct, so its shape is generated to TypeScript with the rest.
//!
//! # Command set
//!
//! Each command is one native capability a `WKWebView` page can't reach. Design 33 names the
//! first five; the badge and delivered-notification commands are this crate's reading of its
//! "Read state, badge and cleanup" seams:
//!
//! - permission and token: `push_permission`, `request_push_permission` and `push_target`. The
//!   page reads the permission at launch to choose between the prompt and a silent
//!   re-registration, and only `request_push_permission` can show the system prompt. The token
//!   arrives asynchronously from the app delegate, so it is read separately from the request, and
//!   the shell announces a new or changed one with the `weblounge:push-target` page event;
//! - blocked notifications: `open_app_settings` opens the app's notification settings. Once the
//!   user has denied the prompt, iOS never shows it again and only the user can re-enable
//!   notifications in Settings, so the page offers "Open Settings" instead of a prompt;
//! - route keys: `create_route_keys` and `drop_route_keys`. Creating also stores the route's
//!   network label and nickname, the route metadata the extension formats a push with,
//!   because they are needed exactly as long as the keys;
//! - re-registration (design 23 step 7): `routes_needing_reregistration` answers the
//!   [`RouteId`]s whose pushes the extension could no longer decrypt. The extension can't reach
//!   the page's route records, so it flags the route in the App Group for the page to read at
//!   launch and on foreground and register again with new keys. Creating or dropping a route's
//!   keys clears its flag, so the list needs no acknowledgement;
//! - tap before history: `take_pushed_messages`;
//! - `BadgeNavigator`: one `set_badge`, because `setBadgeCount(0)` is how iOS clears it;
//! - `writeNotificationCounts`: `write_notification_counts`, which writes the
//!   per-conversation counts and read markers the extension starts from;
//! - `RegistrationProvider`: `delivered_notifications` for `getNotifications()` and
//!   `remove_delivered_notifications` for `close()`.

mod buffer_route;
mod command;
mod delivered;
mod error;
mod page_event;
mod push;
mod pushed_message;
mod read_state;
mod route_keys;
mod validated;

pub use buffer_route::BufferRoutePath;
pub use command::NativeCommand;
pub use delivered::{
    ChatNotificationData, DeliveredNotification, NotificationData,
    RemoveDeliveredNotificationsRequest, RouteNotificationData,
};
pub use error::NativeBridgeError;
pub use page_event::{AppLifecycle, PageEvent};
pub use push::{ApnsEnvironment, ApnsToken, PushPermission, PushTarget};
pub use pushed_message::{PushedMessage, PushedMessageKind, PushedMessageSchema};
pub use read_state::{
    ConversationNotificationCount, SetBadgeRequest, WriteNotificationCountsRequest,
};
pub use route_keys::{
    AuthSecret, CreateRouteKeysRequest, DropRouteKeysRequest, P256dhKey, RouteId, RouteKeys,
    RouteMeta,
};
pub use validated::InvalidValue;
