use std::{error::Error, fmt, time::Duration};

use anyhow::{Context, Result, anyhow, bail};
use chrono::{NaiveDate, TimeZone, Utc};
use html5ever::{parse_document, tendril::TendrilSink};
use markup5ever_rcdom::{Handle, NodeData, RcDom};
use paperless_models::{InferredMetadata, OcrBlock};
use reqwest::{Client, StatusCode};
use serde::Deserialize;
use tracing::debug;
use url::Url;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// The agent sends a keep-alive every 20 seconds, so a longer silence means it stalled.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// The indexing agent (`agent/`): one Pi agent session per document reads every page and
/// returns the page text as positioned blocks, with the document's details. Paperless itself
/// calls no model; it stores what the session returns.
#[derive(Clone)]
pub struct IndexingAgent {
    client: Client,
    endpoint: Url,
}

/// A document as the indexing agent read it.
#[derive(Debug, Clone, PartialEq)]
pub struct IndexedDocument {
    pub pages: Vec<IndexedPage>,
    pub metadata: InferredMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedPage {
    pub page: u32,
    pub text: String,
    pub blocks: Vec<OcrBlock>,
    pub html: String,
}

impl IndexingAgent {
    pub fn new(agent_url: &Url) -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(STREAM_IDLE_TIMEOUT)
                .build()
                .context("build indexing agent client")?,
            endpoint: agent_url.join("index").context("indexing agent URL")?,
        })
    }

    /// Runs one indexing session for the document and waits for its result.
    pub async fn index(&self, document_id: u64, page_count: u32) -> Result<IndexedDocument> {
        let mut response = match self
            .client
            .post(self.endpoint.clone())
            .json(&serde_json::json!({ "document_id": document_id }))
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                return Err(transient(
                    anyhow::Error::from(error).context("reach the indexing agent"),
                ));
            }
        };
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            let error = anyhow!(
                "indexing agent returned {status}: {}",
                body.chars().take(500).collect::<String>()
            );
            return Err(
                if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS {
                    transient(error)
                } else {
                    error
                },
            );
        }
        let mut buffer = Vec::new();
        loop {
            let chunk = match response.chunk().await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(error) => {
                    return Err(transient(
                        anyhow::Error::from(error).context("read the indexing agent's stream"),
                    ));
                }
            };
            buffer.extend_from_slice(&chunk);
            while let Some(end) = buffer.windows(2).position(|window| window == b"\n\n") {
                let event = buffer.drain(..end + 2).collect::<Vec<_>>();
                if let Some(outcome) = read_event(&event, page_count)? {
                    return outcome;
                }
            }
        }
        Err(transient(anyhow!(
            "the indexing agent closed its stream without a result"
        )))
    }
}

#[derive(Debug, Deserialize)]
struct AgentResult {
    pages: Vec<AgentPage>,
    title: Option<String>,
    sender: Option<String>,
    created_at: Option<String>,
    summary: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AgentPage {
    page: u32,
    blocks: Vec<AgentBlock>,
}

#[derive(Debug, Deserialize)]
struct AgentBlock {
    label: String,
    bbox: [u16; 4],
    html: String,
}

#[derive(Debug, Deserialize)]
struct AgentError {
    message: String,
    #[serde(default)]
    transient: bool,
}

/// One server-sent event: `None` for progress and keep-alives, else the session's outcome.
fn read_event(raw: &[u8], page_count: u32) -> Result<Option<Result<IndexedDocument>>> {
    let raw = std::str::from_utf8(raw).context("indexing agent sent non-UTF-8 text")?;
    let mut name = "message";
    let mut data = String::new();
    for line in raw.lines() {
        if let Some(value) = line.strip_prefix("event:") {
            name = value.trim();
        } else if let Some(value) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.strip_prefix(' ').unwrap_or(value));
        }
    }
    match name {
        "result" => {
            let result: AgentResult =
                serde_json::from_str(&data).context("parse the indexing agent's result")?;
            Ok(Some(convert(result, page_count)))
        }
        "error" => {
            let error: AgentError =
                serde_json::from_str(&data).context("parse the indexing agent's error")?;
            let failure = anyhow!("indexing agent: {}", error.message);
            Ok(Some(Err(if error.transient {
                transient(failure)
            } else {
                failure
            })))
        }
        _ => {
            if !data.is_empty() {
                debug!(event = name, data = %data, "indexing progress");
            }
            Ok(None)
        }
    }
}

fn convert(result: AgentResult, page_count: u32) -> Result<IndexedDocument> {
    let mut pages = result.pages;
    pages.sort_by_key(|page| page.page);
    let numbers = pages.iter().map(|page| page.page).collect::<Vec<_>>();
    if numbers != (1..=page_count).collect::<Vec<_>>() {
        bail!("indexing agent returned pages {numbers:?} for a {page_count} page document");
    }
    let pages = pages
        .into_iter()
        .map(|page| page_from_blocks(page.page, &page.blocks))
        .collect::<Result<Vec<_>>>()?;
    let created_at = result
        .created_at
        .map(|value| {
            NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d")
                .map(|date| Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0).unwrap()))
                .with_context(|| format!("invalid created_at from the indexing agent: {value}"))
        })
        .transpose()?;
    Ok(IndexedDocument {
        pages,
        metadata: InferredMetadata {
            title: result.title,
            sender: result.sender,
            created_at,
            summary: result.summary,
        },
    })
}

/// Stores the blocks the way the reader expects them: one positioned `div` per block.
fn page_from_blocks(page: u32, blocks: &[AgentBlock]) -> Result<IndexedPage> {
    let mut html = String::new();
    for block in blocks {
        let [x0, y0, x1, y1] = block.bbox;
        if x0 >= x1 || y0 >= y1 || x1 > 1000 || y1 > 1000 {
            bail!("page {page}: block bbox must be x0 y0 x1 y1 within 0-1000");
        }
        if block.label.trim().is_empty() {
            bail!("page {page}: block has an empty label");
        }
        if !html.is_empty() {
            html.push('\n');
        }
        html.push_str(&format!(
            r#"<div data-label="{}" data-bbox="{x0} {y0} {x1} {y1}">{}</div>"#,
            escape_attribute(block.label.trim()),
            block.html
        ));
    }
    let blocks = parse_blocks(&html).with_context(|| format!("page {page}"))?;
    Ok(IndexedPage {
        page,
        text: html2md::parse_html(&html).trim().to_owned(),
        blocks,
        html,
    })
}

fn escape_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn parse_blocks(html: &str) -> Result<Vec<OcrBlock>> {
    let document = parse_document(RcDom::default(), Default::default()).one(html);
    let mut blocks = Vec::new();
    collect_blocks(&document.document, &mut blocks)?;
    Ok(blocks)
}

fn collect_blocks(handle: &Handle, blocks: &mut Vec<OcrBlock>) -> Result<()> {
    if let NodeData::Element { name, attrs, .. } = &handle.data
        && name.local.as_ref() == "div"
    {
        let attributes = attrs.borrow();
        let attribute = |wanted: &str| {
            attributes
                .iter()
                .find(|attribute| attribute.name.local.as_ref() == wanted)
                .map(|attribute| attribute.value.to_string())
        };
        let (label, bbox) = (attribute("data-label"), attribute("data-bbox"));
        drop(attributes);
        if let (Some(label), Some(bbox)) = (label, bbox) {
            let mut raw_text = String::new();
            collect_text(handle, &mut raw_text);
            blocks.push(OcrBlock {
                label,
                bbox: parse_bbox(&bbox)?,
                text: raw_text.split_whitespace().collect::<Vec<_>>().join(" "),
            });
            return Ok(());
        }
    }
    for child in handle.children.borrow().iter() {
        collect_blocks(child, blocks)?;
    }
    Ok(())
}

fn collect_text(handle: &Handle, output: &mut String) {
    if let NodeData::Text { contents } = &handle.data {
        output.push_str(&contents.borrow());
        output.push(' ');
    }
    for child in handle.children.borrow().iter() {
        collect_text(child, output);
    }
}

fn parse_bbox(value: &str) -> Result<[u16; 4]> {
    let coordinates = value
        .split_whitespace()
        .map(str::parse::<u16>)
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("block data-bbox contains a non-number")?;
    match coordinates.as_slice() {
        &[x0, y0, x1, y1] => Ok([x0, y0, x1, y1]),
        _ => bail!("block data-bbox must have four numbers"),
    }
}

/// A failure worth retrying later: the agent or the model was unreachable or busy.
#[derive(Debug)]
struct TransientFailure {
    source: anyhow::Error,
}

impl fmt::Display for TransientFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.source, formatter)
    }
}

impl Error for TransientFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.source.as_ref())
    }
}

fn transient(source: anyhow::Error) -> anyhow::Error {
    TransientFailure { source }.into()
}

pub fn is_transient_failure(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.downcast_ref::<TransientFailure>().is_some())
}

#[cfg(test)]
mod tests {
    use super::{is_transient_failure, read_event};

    #[test]
    fn turns_the_agent_result_into_stored_pages_and_details() {
        let event = br#"event: result
data: {"pages":[{"page":1,"blocks":[{"label":"Section-Header","bbox":[80,60,600,90],"html":"<h2>Beitragsbescheid</h2>"},{"label":"Text","bbox":[80,120,920,200],"html":"<p>Ihr Beitrag ab 01.06.2025 betr\u00e4gt <b>212,50 Euro</b>.</p>"}]}],"title":"Beitragsbescheid 2025","sender":"IKK classic","created_at":"2025-05-14","summary":"Bescheid."}

"#;
        let document = read_event(event, 1).unwrap().unwrap().unwrap();
        let page = &document.pages[0];
        assert_eq!(page.blocks.len(), 2);
        assert_eq!(page.blocks[1].bbox, [80, 120, 920, 200]);
        assert_eq!(
            page.blocks[1].text,
            "Ihr Beitrag ab 01.06.2025 beträgt 212,50 Euro ."
        );
        assert!(
            page.html
                .starts_with(r#"<div data-label="Section-Header" data-bbox="80 60 600 90">"#)
        );
        assert!(page.text.contains("Beitragsbescheid"));
        assert_eq!(document.metadata.sender.as_deref(), Some("IKK classic"));
        assert_eq!(
            document.metadata.created_at.unwrap().to_rfc3339(),
            "2025-05-14T00:00:00+00:00"
        );
    }

    #[test]
    fn rejects_missing_pages_and_bad_boxes() {
        let missing = br#"event: result
data: {"pages":[{"page":2,"blocks":[]}],"title":null,"sender":null,"created_at":null,"summary":null}
"#;
        assert!(read_event(missing, 2).unwrap().unwrap().is_err());
        let flipped = br#"event: result
data: {"pages":[{"page":1,"blocks":[{"label":"Text","bbox":[900,0,100,50],"html":"<p>x</p>"}]}],"title":null,"sender":null,"created_at":null,"summary":null}
"#;
        assert!(read_event(flipped, 1).unwrap().unwrap().is_err());
    }

    #[test]
    fn keeps_the_agents_transient_flag_and_skips_progress() {
        assert!(
            read_event(
                b"event: progress\ndata: {\"label\":\"Reading page 1\"}\n",
                1
            )
            .unwrap()
            .is_none()
        );
        assert!(read_event(b": keep-alive\n", 1).unwrap().is_none());
        let busy = read_event(
            b"event: error\ndata: {\"message\":\"the model failed\",\"transient\":true}\n",
            1,
        )
        .unwrap()
        .unwrap()
        .unwrap_err();
        assert!(is_transient_failure(&busy));
        let broken = read_event(
            b"event: error\ndata: {\"message\":\"no pages\",\"transient\":false}\n",
            1,
        )
        .unwrap()
        .unwrap()
        .unwrap_err();
        assert!(!is_transient_failure(&broken));
    }
}
