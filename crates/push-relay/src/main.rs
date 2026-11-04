//! Command-line entry point for the weblounge push relay.

use std::process::ExitCode;

use clap::Parser;
use weblounge_push_relay::{
    ConciergeClient, Config, Database, EndpointValidator, WebPushSender, app,
    prepare_state_directory,
};

#[tokio::main]
async fn main() -> ExitCode {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .try_init();
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("push relay failed: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> weblounge_push_relay::Result<()> {
    let config = Config::parse();
    config.validate()?;
    prepare_state_directory(&config.state_dir).await?;

    let secret = tokio::fs::read_to_string(&config.concierge_secret_file)
        .await?
        .trim_end()
        .to_owned();
    if secret.is_empty() {
        return Err(weblounge_push_relay::Error::Config(
            "the concierge secret file is empty".to_owned(),
        ));
    }
    let vapid_key = tokio::fs::read(&config.vapid_key_file).await?;

    let database = Database::open(config.database_path()).await?;
    let concierge = ConciergeClient::new(config.concierge_url.clone(), secret)?;
    #[cfg(feature = "push-e2e")]
    let (targets, sender) = if let (false, Some(ca_file)) =
        (config.test_target_host.is_empty(), &config.test_ca_file)
    {
        let targets = EndpointValidator::push_e2e(config.test_target_host.clone());
        let root = tokio::fs::read(ca_file).await?;
        let sender = WebPushSender::push_e2e(&vapid_key, targets.clone(), &root)?;
        (targets, sender)
    } else {
        let targets = EndpointValidator::production();
        let sender = WebPushSender::new(&vapid_key, targets.clone())?;
        (targets, sender)
    };
    #[cfg(not(feature = "push-e2e"))]
    let (targets, sender) = {
        let targets = EndpointValidator::production();
        let sender = WebPushSender::new(&vapid_key, targets.clone())?;
        (targets, sender)
    };
    let service = app(
        database,
        concierge,
        sender,
        targets,
        &config.origin,
        &config.allowed_origins,
    );
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    axum::serve(listener, service).await.map_err(Into::into)
}
