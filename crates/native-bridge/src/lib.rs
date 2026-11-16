//! The contract between the hosted page and the iOS shell (design 33).
//!
//! The page calls the shell through Tauri `invoke` with a [`NativeCommand`] name, and the shell
//! answers with the command's result or a serialized error. The shell talks back through page
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
//! - permission and token: `request_push_permission` and `push_target`. The token arrives
//!   asynchronously from the app delegate, so it is read separately from the request;
//! - route keys: `create_route_keys` and `drop_route_keys`. Creating also stores the route's
//!   network label and nickname, the route metadata the extension formats a push with,
//!   because they are needed exactly as long as the keys;
//! - tap before history: `take_pushed_messages`;
//! - `BadgeNavigator`: one `set_badge`, because `setBadgeCount(0)` is how iOS clears it;
//! - `writeNotificationCounts`: `write_notification_counts`, which writes the
//!   per-conversation counts and read markers the extension starts from;
//! - `RegistrationProvider`: `delivered_notifications` for `getNotifications()` and
//!   `remove_delivered_notifications` for `close()`.

mod buffer_route;
mod command;
mod delivered;
mod page_event;
mod push;
mod pushed_message;
mod route_keys;
mod validated;

pub use buffer_route::BufferRoutePath;
pub use command::NativeCommand;
pub use delivered::{
    ChatNotificationData, DeliveredNotification, NotificationData,
    RemoveDeliveredNotificationsRequest, RouteNotificationData,
};
pub use page_event::{AppLifecycle, PageEvent};
pub use push::{ApnsEnvironment, ApnsToken, PushPermission, PushTarget};
pub use pushed_message::{PushedMessage, PushedMessageKind, PushedMessageSchema};
pub use route_keys::{
    AuthSecret, CreateRouteKeysRequest, DropRouteKeysRequest, P256dhKey, RouteId, RouteKeys,
    RouteMeta,
};
pub use validated::InvalidValue;
