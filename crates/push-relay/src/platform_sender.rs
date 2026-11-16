use async_trait::async_trait;

use crate::{
    ApnsSender, Delivery, Error, PushOutcome, PushSender, Result, WebPushSender, target::PushTarget,
};

/// Routes each delivery to the sender for its target's platform.
#[derive(Clone, Debug)]
pub struct PlatformSender<W = WebPushSender, A = ApnsSender> {
    web_push: W,
    apns: Option<A>,
}

impl<W, A> PlatformSender<W, A> {
    /// Delivers APNs targets only when an APNs sender is configured.
    #[must_use]
    pub fn new(web_push: W, apns: Option<A>) -> Self {
        Self { web_push, apns }
    }
}

#[async_trait]
impl<W: PushSender, A: PushSender> PushSender for PlatformSender<W, A> {
    async fn send(&self, delivery: Delivery) -> Result<PushOutcome> {
        match (&delivery.target, &self.apns) {
            (PushTarget::WebPush(_), _) => self.web_push.send(delivery).await,
            (PushTarget::Apns(_), Some(apns)) => apns.send(delivery).await,
            (PushTarget::Apns(_), None) => Err(Error::DeliveryUnavailable),
        }
    }

    fn delivers_apns(&self) -> bool {
        self.apns.is_some()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;

    use super::PlatformSender;
    use crate::{
        Delivery, Error, PushOutcome, PushSender, Result, Urgency,
        target::{ApnsEnvironment, ApnsTarget, PushTarget},
    };

    #[derive(Clone)]
    struct Recording {
        platform: &'static str,
        sent: Arc<Mutex<Vec<&'static str>>>,
    }

    fn recording(platform: &'static str, sent: &Arc<Mutex<Vec<&'static str>>>) -> Recording {
        Recording {
            platform,
            sent: Arc::clone(sent),
        }
    }

    #[async_trait]
    impl PushSender for Recording {
        async fn send(&self, _delivery: Delivery) -> Result<PushOutcome> {
            self.sent.lock().expect("sent").push(self.platform);
            Ok(PushOutcome::Accepted)
        }
    }

    fn apns_delivery() -> Delivery {
        Delivery {
            route_id: "route".to_owned(),
            target: PushTarget::Apns(ApnsTarget {
                token: "ab".repeat(32),
                environment: ApnsEnvironment::Production,
            }),
            body: b"ciphertext".to_vec(),
            ttl: 60,
            urgency: Urgency::High,
        }
    }

    fn web_push_delivery() -> Delivery {
        Delivery::web_push(
            "route",
            "https://fcm.googleapis.com/fcm/send/abc",
            "key",
            "auth",
            b"ciphertext".to_vec(),
            60,
        )
    }

    #[tokio::test]
    async fn each_target_reaches_its_platform_sender() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let sender =
            PlatformSender::new(recording("web push", &sent), Some(recording("apns", &sent)));
        assert!(sender.delivers_apns());
        for delivery in [apns_delivery(), web_push_delivery()] {
            sender.send(delivery).await.expect("sent");
        }
        assert_eq!(*sent.lock().expect("sent"), ["apns", "web push"]);
    }

    #[tokio::test]
    async fn without_an_apns_key_only_web_push_is_delivered() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let sender = PlatformSender::<_, Recording>::new(recording("web push", &sent), None);
        assert!(!sender.delivers_apns());
        assert!(matches!(
            sender.send(apns_delivery()).await,
            Err(Error::DeliveryUnavailable)
        ));
        sender.send(web_push_delivery()).await.expect("web push");
        assert_eq!(*sent.lock().expect("sent"), ["web push"]);
    }
}
