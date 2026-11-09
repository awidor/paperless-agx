//! Scan from the printer without the server, for checking the scanner itself:
//!
//! ```sh
//! cargo run -p paperless-scanner --example scan -- --host 192.168.1.218 info
//! cargo run -p paperless-scanner --example scan -- --host 192.168.1.218 scan --source feeder -o scan.pdf
//! ```

use std::{path::PathBuf, time::Instant};

use anyhow::Result;
use clap::{Parser, Subcommand, ValueEnum};
use paperless_scanner::{DEFAULT_PORT, ScanMode, ScanSettings, ScanSource, Scanner, render_pdf};

#[derive(Parser)]
struct Arguments {
    #[arg(long, env = "SCANNER_HOST", default_value = "192.168.1.218")]
    host: String,
    #[arg(long, default_value_t = DEFAULT_PORT)]
    port: u16,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Show what the scanner reports about itself.
    Info,
    /// Scan to a PDF.
    Scan {
        #[arg(long, value_enum, default_value = "auto")]
        source: Source,
        #[arg(long, value_enum, default_value = "gray")]
        mode: Mode,
        #[arg(long, default_value_t = 300)]
        dpi: u16,
        #[arg(short, long, default_value = "scan.pdf")]
        output: PathBuf,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum Source {
    Auto,
    Feeder,
    Glass,
}

#[derive(Clone, Copy, ValueEnum)]
enum Mode {
    Color,
    Gray,
    BlackWhite,
}

#[tokio::main]
async fn main() -> Result<()> {
    let arguments = Arguments::parse();
    let scanner = Scanner::new(&arguments.host, arguments.port);
    match arguments.command {
        Command::Info => println!("{:#?}", scanner.info().await?),
        Command::Scan {
            source,
            mode,
            dpi,
            output,
        } => {
            let source = match source {
                Source::Auto => ScanSource::Auto,
                Source::Feeder => ScanSource::Feeder,
                Source::Glass => ScanSource::Glass,
            };
            let mode = match mode {
                Mode::Color => ScanMode::Color,
                Mode::Gray => ScanMode::Gray,
                Mode::BlackWhite => ScanMode::BlackWhite,
            };
            let started = Instant::now();
            let pages = scanner
                .scan(ScanSettings { source, dpi }, |pages| {
                    eprintln!("page {pages} after {:.1}s", started.elapsed().as_secs_f32());
                })
                .await?;
            let pdf = render_pdf(&pages, mode)?;
            std::fs::write(&output, &pdf)?;
            eprintln!(
                "{} page(s), {} KB in {:.1}s: {}",
                pages.len(),
                pdf.len() / 1024,
                started.elapsed().as_secs_f32(),
                output.display()
            );
        }
    }
    Ok(())
}
