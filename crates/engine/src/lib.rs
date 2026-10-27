//! Platform-neutral weblounge engine composition.

/// Creates a papo client builder for a weblounge connection.
pub fn client_builder(endpoint: &str, nickname: &str) -> papo::Builder {
    papo::Client::builder(endpoint, nickname)
}

#[cfg(test)]
mod tests {
    use papo_testing::wire;

    #[tokio::test]
    async fn client_builder_registers_with_papo() {
        let (_client, mut events, mut wire) =
            wire(super::client_builder("irc://offline.test", "weblounge"));

        wire.register(&[]).await;

        loop {
            match events.next().await {
                Some(papo::Event::Connected(connected)) => {
                    assert_eq!(connected.welcome, "Welcome to the ErgoTest IRC Network");
                    break;
                }
                Some(_) => {}
                None => panic!("papo stopped before registration completed"),
            }
        }
    }
}
