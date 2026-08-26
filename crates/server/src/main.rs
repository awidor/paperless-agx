use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Parser;
use paperless_server::{AppConfig, build_app};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(about = "Paperless AGX local document server")]
struct Arguments {
    #[arg(
        long,
        env = "PAPERLESS_CONFIG",
        default_value = "config/paperless-agx.toml"
    )]
    config: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "paperless=info,tower_http=info".into()),
        )
        .init();
    let arguments = Arguments::parse();
    let config = AppConfig::load(arguments.config).await?;
    let listen_addr = config.listen_addr;
    let app = build_app(config).await?;
    let listener = tokio::net::TcpListener::bind(listen_addr)
        .await
        .with_context(|| format!("bind {listen_addr}"))?;
    tracing::info!(%listen_addr, "server started");
    axum::serve(listener, app).await.context("serve HTTP")
}
