# Paperless-AGX

Document OCR and agentic search with page references. Rust, React, SQLite, and a TypeScript search agent built on [Pi](https://github.com/earendil-works/pi).

## Setup

- Rust 1.96+, Bun 1.3+, Node.js 24, and Poppler (`poppler-utils`).
- Local llama.cpp OCR server: Surya OCR 2.5 (`surya`, served with `--special`) or Chandra OCR 2 (`chandra`); choose with `[ocr] profile`.
- OpenRouter API access for metadata and summaries, `google/gemini-embedding-2` search embeddings, and the search agent's model (`anthropic/claude-haiku-5.5` on medium reasoning, set in `config/paperless-agent.toml`).
- Copy `.env.example` to `.env` and set your API keys.
- The web build downloads the General Sans font from Fontshare into `web/public/fonts`. Its license allows self-hosting but not redistribution, so the files are not in the repository. Without network access at build time, the interface falls back to the system sans.
- Set endpoints in `config/paperless-agx.toml`. Model-server example: `config/llama-models.ini`.

```sh
cd web
bun install --frozen-lockfile
bun run build
cd ..
cargo run --locked -p paperless-server
```

The search agent (`agent/`) runs next to it. For a local run, copy `config/paperless-agent.toml` to `config/paperless-agent.local.toml` and set `paperless_url = "http://127.0.0.1:3000"`:

```sh
cd agent
bun install --frozen-lockfile
PAPERLESS_AGENT_CONFIG=../config/paperless-agent.local.toml bun run start
```

## Search

- The search agent answers every search. It looks things up in the archive: passage search, document lists by sender or date, and page reading. It then ranks the matching documents, gives the reason for each, and answers questions the documents answer, citing its sources. The page shows each lookup while it works.
- Put the whole query in quotes, such as `"285 334 268"`, to find passages containing that exact text instead. That search is instant and does not use the agent.
- The agent only cites documents and passages its lookups returned, and quotes only text found on the page.
- Every document gets a short AI summary when it is indexed, and the summary is searchable too. Documents indexed before summaries existed are summarized at the next start.
- Score the agent on your own queries with `bun run eval <queries.json>` in `agent/`. The file is a list of `{"query": "...", "expected": [document ids]}`, and `--model` tries another OpenRouter model.

- Open http://127.0.0.1:3000.
- Local use: no built-in authentication.
- Documents stay in `data/`; extracted text, search queries, and the text the agent reads are sent to OpenRouter, restricted to zero-data-retention providers.
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

MIT. The Chandra prompt retains its upstream license in `licenses/chandra.txt`.
