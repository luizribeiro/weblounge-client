//! Command-line entry point for the weblounge push relay.

use std::process::ExitCode;

use clap::Parser;
use weblounge_push_relay::{
    ConciergeClient, Config, Database, EndpointValidator, WebPushSender, app,
    prepare_state_directory,
};

#[tokio::main]
async fn main() -> ExitCode {
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
    let targets = EndpointValidator::production();
    let sender = WebPushSender::new(&vapid_key, targets.clone())?;
    let service = app(database, concierge, sender, targets, &config.origin);
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    axum::serve(listener, service).await.map_err(Into::into)
}
