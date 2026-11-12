//! Command logic over an abstract notification center.

use std::{
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

use serde::Serialize;

use super::model::{InvalidId, Notification, Permission, validated_id};

#[derive(Debug, thiserror::Error)]
pub enum CenterError {
    #[error("the notification center did not answer in time")]
    Timeout,
    #[error("the notification center refused: {0}")]
    Refused(String),
    #[error("notifications need the app to run from its bundle")]
    NoBundle,
}

pub trait NotificationCenter: Send + Sync + 'static {
    fn permission(&self) -> Result<Permission, CenterError>;
    fn request_permission(&self) -> Result<Permission, CenterError>;
    fn post(&self, notification: &Notification) -> Result<(), CenterError>;
    fn remove(&self, id: &str);
}

pub fn answer_within<T>(answers: &mpsc::Receiver<T>, timeout: Duration) -> Result<T, CenterError> {
    answers
        .recv_timeout(timeout)
        .map_err(|_| CenterError::Timeout)
}

#[derive(Debug, thiserror::Error)]
pub enum NotificationError {
    #[error(transparent)]
    InvalidId(#[from] InvalidId),
    #[error("a permission request is already waiting for an answer")]
    RequestPending,
    #[error(transparent)]
    Center(#[from] CenterError),
    #[error("notification task failed: {0}")]
    Task(#[from] tauri::Error),
}

impl Serialize for NotificationError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub struct Service {
    center: Arc<dyn NotificationCenter>,
    // Keeps center calls from overlapping; the page orders them by waiting for each to settle.
    center_call_lock: Mutex<()>,
    permission_request_pending: AtomicBool,
}

struct PendingRequest<'a>(&'a AtomicBool);

impl Drop for PendingRequest<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl Service {
    pub fn new(center: Arc<dyn NotificationCenter>) -> Self {
        Self {
            center,
            center_call_lock: Mutex::new(()),
            permission_request_pending: AtomicBool::new(false),
        }
    }

    pub fn permission(&self) -> Result<Permission, NotificationError> {
        Ok(self.center.permission()?)
    }

    pub fn request_permission(&self) -> Result<Permission, NotificationError> {
        let already_pending = self.permission_request_pending.swap(true, Ordering::AcqRel);
        if already_pending {
            return Err(NotificationError::RequestPending);
        }
        let _pending = PendingRequest(&self.permission_request_pending);
        Ok(self.center.request_permission()?)
    }

    pub fn post(&self, id: &str, title: &str, body: Option<&str>) -> Result<(), NotificationError> {
        let notification = Notification::from_page(id, title, body)?;
        let _turn = self.take_turn();
        Ok(self.center.post(&notification)?)
    }

    pub fn close(&self, id: &str) -> Result<(), NotificationError> {
        let id = validated_id(id)?;
        let _turn = self.take_turn();
        self.center.remove(id);
        Ok(())
    }

    fn take_turn(&self) -> std::sync::MutexGuard<'_, ()> {
        self.center_call_lock
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::atomic::AtomicUsize, thread};

    use super::*;

    #[derive(Default)]
    struct FakeCenter {
        calls: Mutex<Vec<String>>,
        permission: Mutex<Option<Permission>>,
        refuses: bool,
        overlapping_calls: AtomicUsize,
        in_flight: AtomicBool,
        gate: Mutex<Option<mpsc::Receiver<()>>>,
    }

    impl FakeCenter {
        fn record(&self, call: String) {
            self.calls.lock().expect("calls lock").push(call);
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().expect("calls lock").clone()
        }

        fn enter_and_leave(&self) {
            if self.in_flight.swap(true, Ordering::SeqCst) {
                self.overlapping_calls.fetch_add(1, Ordering::SeqCst);
            }
            thread::sleep(Duration::from_millis(5));
            self.in_flight.store(false, Ordering::SeqCst);
        }
    }

    impl NotificationCenter for FakeCenter {
        fn permission(&self) -> Result<Permission, CenterError> {
            Ok(self
                .permission
                .lock()
                .expect("permission lock")
                .unwrap_or(Permission::Default))
        }

        fn request_permission(&self) -> Result<Permission, CenterError> {
            if let Some(gate) = self.gate.lock().expect("gate lock").take() {
                gate.recv().expect("gate opens");
            }
            if self.refuses {
                return Err(CenterError::Refused("UNErrorDomain error 1".to_owned()));
            }
            Ok(Permission::Granted)
        }

        fn post(&self, notification: &Notification) -> Result<(), CenterError> {
            self.enter_and_leave();
            if self.refuses {
                return Err(CenterError::Refused("UNErrorDomain error 1".to_owned()));
            }
            self.record(format!(
                "post {} | {} | {}",
                notification.id, notification.title, notification.body
            ));
            Ok(())
        }

        fn remove(&self, id: &str) {
            self.enter_and_leave();
            self.record(format!("remove {id}"));
        }
    }

    fn service_with(center: FakeCenter) -> (Arc<FakeCenter>, Service) {
        let center = Arc::new(center);
        (Arc::clone(&center), Service::new(center))
    }

    #[test]
    fn posting_passes_the_capped_notification_to_the_center() {
        let (center, service) = service_with(FakeCenter::default());
        service
            .post("libera/#rust", "#rust", Some("luiz: hello"))
            .expect("posts");
        assert_eq!(center.calls(), ["post libera/#rust | #rust | luiz: hello"]);
    }

    #[test]
    fn an_invalid_id_never_reaches_the_center() {
        let (center, service) = service_with(FakeCenter::default());
        assert!(matches!(
            service.post("", "title", None),
            Err(NotificationError::InvalidId(_))
        ));
        assert!(matches!(
            service.close(""),
            Err(NotificationError::InvalidId(_))
        ));
        assert!(center.calls().is_empty());
    }

    #[test]
    fn a_refusing_center_is_reported_to_the_caller() {
        let (_, service) = service_with(FakeCenter {
            refuses: true,
            ..FakeCenter::default()
        });
        let error = service.post("t", "title", None).expect_err("refused");
        assert!(matches!(
            error,
            NotificationError::Center(CenterError::Refused(_))
        ));
    }

    #[test]
    fn errors_serialize_as_their_message() {
        let error = NotificationError::from(CenterError::NoBundle);
        assert_eq!(
            serde_json::to_string(&error).expect("serializes"),
            r#""notifications need the app to run from its bundle""#
        );
    }

    #[test]
    fn a_missing_answer_times_out() {
        let (_send, answers) = mpsc::channel::<()>();
        assert!(matches!(
            answer_within(&answers, Duration::from_millis(10)),
            Err(CenterError::Timeout)
        ));
        let (send, answers) = mpsc::channel();
        send.send(7).expect("receiver alive");
        assert_eq!(
            answer_within(&answers, Duration::from_millis(10)).expect("answer"),
            7
        );
    }

    #[test]
    fn close_then_post_for_one_tag_reach_the_center_in_that_order() {
        let (center, service) = service_with(FakeCenter::default());
        service.close("t").expect("closes");
        service.post("t", "again", None).expect("posts");
        assert_eq!(center.calls(), ["remove t", "post t | again | "]);
    }

    #[test]
    fn center_calls_from_many_threads_never_overlap() {
        let (center, service) = service_with(FakeCenter::default());
        let service = Arc::new(service);
        let workers: Vec<_> = (0..8)
            .map(|index| {
                let service = Arc::clone(&service);
                thread::spawn(move || {
                    service.post("t", "title", None).expect("posts");
                    service.close(&format!("t{index}")).expect("closes");
                })
            })
            .collect();
        for worker in workers {
            worker.join().expect("worker finishes");
        }
        assert_eq!(center.overlapping_calls.load(Ordering::SeqCst), 0);
        assert_eq!(center.calls().len(), 16);
    }

    #[test]
    fn a_second_permission_request_is_rejected_while_one_waits() {
        let (open_gate, gate) = mpsc::channel();
        let (center, service) = service_with(FakeCenter::default());
        *center.gate.lock().expect("gate lock") = Some(gate);
        let service = Arc::new(service);
        let waiting = {
            let service = Arc::clone(&service);
            thread::spawn(move || service.request_permission())
        };
        while !service.permission_request_pending.load(Ordering::Acquire) {
            thread::yield_now();
        }
        assert!(matches!(
            service.request_permission(),
            Err(NotificationError::RequestPending)
        ));
        open_gate.send(()).expect("request waiting");
        assert_eq!(
            waiting.join().expect("thread finishes").expect("granted"),
            Permission::Granted
        );
        assert_eq!(
            service
                .request_permission()
                .expect("a new request is allowed"),
            Permission::Granted
        );
    }

    #[test]
    fn the_current_permission_comes_from_the_center() {
        let (center, service) = service_with(FakeCenter::default());
        *center.permission.lock().expect("permission lock") = Some(Permission::Denied);
        assert_eq!(service.permission().expect("reads"), Permission::Denied);
    }
}
