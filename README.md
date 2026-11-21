# Paperless-AGX

Document OCR and agentic search with page references. Rust, SolidJS, SQLite, and a TypeScript search agent built on [Pi](https://github.com/earendil-works/pi).

## Setup

- Rust 1.96+, Bun 1.3+, Node.js 24, and Poppler (`poppler-utils`).
- OpenRouter API access for the agents' model and the `google/gemini-embedding-2` search embeddings.
- Copy `.env.example` to `.env` and set your API key.
- The web build downloads the General Sans font from Fontshare into `web/public/fonts`. Its license allows self-hosting but not redistribution, so the files are not in the repository. Without network access at build time, the interface falls back to the system sans.
- Set addresses in `config/paperless-agx.toml` and the model in `config/paperless-agent.toml`.

```sh
cd web
bun install --frozen-lockfile
bun run build
cd ..
cargo run --locked -p paperless-server
```

The agent service (`agent/`) runs next to it; documents are not indexed without it. For a local run, copy `config/paperless-agent.toml` to `config/paperless-agent.local.toml` and set `paperless_url = "http://127.0.0.1:3000"`:

```sh
cd agent
bun install --frozen-lockfile
PAPERLESS_AGENT_CONFIG=../config/paperless-agent.local.toml bun run start
```

## Agents

- All model work runs in the agent service (`agent/`), built on Pi. Paperless itself calls no language model: it renders page images, stores what the agents return, and computes search embeddings.
- One model serves every agent, set once under `[model]` in `config/paperless-agent.toml`: `anthropic/claude-haiku-5.5` on medium reasoning, routed only to zero-data-retention endpoints on Google Vertex and Amazon Bedrock. A model Pi's catalog does not list yet can be described under `[model.definition]`.
- Indexing: each new document gets one agent session. The agent views the page images, saves each page's text as positioned layout blocks, then sets the title, sender, date and summary and finishes. All of it happens in the same conversation, so the provider can reuse its cached prefix. Manual edits to title, sender or date are kept when a document is indexed again (Reprocess document).
- Benchmark indexing on documents already in the archive with `bun run eval:index --sample 10` (or `--documents 12,40`) in `agent/`, with `--reasoning low|medium|high` and `--model`. It compares each new reading with the stored text and blocks and reports word accuracy, block overlap, whether title, sender and date agree, seconds and cost per page, and the share of input tokens served from cache. It writes nothing to the archive.

## Search

- The search agent answers every search. It looks things up in the archive: passage search, document lists by sender or date, and page reading. It then ranks the matching documents, gives the reason for each, and answers questions the documents answer, citing its sources. The page shows each lookup while it works.
- Put the whole query in quotes, such as `"285 334 268"`, to find passages containing that exact text instead. That search is instant and does not use the agent.
- The agent only cites documents and passages its lookups returned, and quotes only text found on the page.
- Every document gets a short AI summary when it is indexed, and the summary is searchable too. Documents indexed before summaries existed are summarized at the next start.
- Score the agent on your own queries with `bun run eval <queries.json>` in `agent/`. The file is a list of `{"query": "...", "expected": [document ids], "answer": true, "facts": ["regex"]}`: `answer` says whether the query should get an answer, and `facts` lists patterns the answer must contain. `--model`, `--reasoning` and `--providers` try another OpenRouter model, `--no-semantic` searches by keywords only and `--no-summaries` leaves the summaries out, and `--repeat` runs each query several times.

## Scanning

- The Scan button in the top bar scans from the Samsung SL-M3870FW at `192.168.1.218`, set in `[scanner]`; without that section there is no button. Choose the feeder, the glass, or Auto (the feeder when paper is in it); gray, color, or black and white; and 150, 300 or 600 dpi. Every sheet scanned becomes one A4 PDF, which is then read like an upload. A 300 dpi page takes about 11 seconds.
- The printer speaks SANE's `xerox_mfp` protocol on TCP port 9400 (`crates/scanner`). Paperless always asks for color JPEG, the one transfer its network firmware gets right, and makes gray and black and white itself; the crate's protocol notes say why.
- A scan runs to the end even if the page is closed, and one scan runs at a time.
- Give the printer a fixed address on the router: Docker containers cannot resolve its `.local` name.
- Check the scanner without the server: `cargo run -p paperless-scanner --example scan -- info`, or `-- scan --source feeder -o scan.pdf`.

- Open http://127.0.0.1:3000.
- Local use: no built-in authentication.
- Documents stay in `data/`; page images, extracted text, search queries, and the text the agents read are sent to OpenRouter, restricted to zero-data-retention providers.
- Changing the embedding model re-embeds stored passages at the next start.
- Docker: use `compose.yaml`; make `data/` writable by UID 10001 and configure `config/paperless-agx.docker.toml` and `config/paperless-agent.toml`.

## Tests

```sh
cargo test --workspace --locked
(cd agent && bun test)
cd web
bun run test:unit
bunx playwright install chromium
bun run test:e2e
```

MIT. The indexing prompt's block content rules are adapted from the Chandra OCR prompt, which retains its upstream license in `licenses/chandra.txt`. The inlined Lucide icons are covered by `licenses/lucide.txt`.
