# Paperless-AGX

Document OCR, search, and answers with page references. Rust, React, and SQLite.

## Setup

- Rust 1.96+, Bun 1.3+, Node.js 24, and Poppler (`poppler-utils`).
- Local Chandra OCR and Harrier embedding services; model aliases `chandra` and `harrier`.
- OpenRouter API access for metadata and answers.
- Copy `.env.example` to `.env` and set your API keys.
- Set endpoints in `config/paperless-agx.toml`. Model-server example: `config/llama-models.ini`.

```sh
cd web
bun install --frozen-lockfile
bun run build
cd ..
cargo run --locked -p paperless-server
```

- Open http://127.0.0.1:3000.
- Local use: no built-in authentication.
- Documents stay in `data/`; extracted text and questions are sent to OpenRouter.
- Docker: use `compose.yaml`; make `data/` writable by UID 10001 and configure `config/paperless-agx.docker.toml`.

## Tests

```sh
cargo test --workspace --locked
cd web
bun run test:unit
bunx playwright install chromium
bun run test:e2e
```

MIT. The Chandra prompt retains its upstream license in `licenses/chandra.txt`.
