# Semantic Answer Tree

*Explore every answer, branch by branch*

Semantic Answer Tree is a local, multi-session transcript for semantic answers. Codex appends each answer to SQLite as an immutable turn. The dedicated viewer lets you browse history by session, recursively expand the answer structure, and inspect inline word meanings. Each answer is generated once when it is published; expanding content never calls the model.

## Quick Start

Node.js `>=22.13.0` is required.

```powershell
npm install
npm run local
```

Start the viewer in another PowerShell terminal:

```powershell
npm run dev
```

Open [http://localhost:4173](http://localhost:4173). By default, the local service listens on `http://127.0.0.1:4318`, the database is stored at `.semantic-answer/semantic-transcript.sqlite3`, and the capability token is stored at `.semantic-answer/capability-token`.

For more detail, see:

- [Setup Guide](docs/SETUP.md) for MCP registration, the Codex session hook, tokens, environment variables, the API, and troubleshooting.
- [Design and Migration](docs/DESIGN-MIGRATION.md) for the append-only SQLite model, WAL, migrations, legacy import, and hosted-demo boundaries.
- [semantic-zoom-final skill](semantic-zoom-final/SKILL.md) for the single-answer surface, history reads, reliable publishing, and failure fallback.

## Common Commands

- `npm run local` starts the only local HTTP service that owns SQLite, validation, migrations, and SSE.
- `npm run dev` starts the dedicated viewer at `http://localhost:4173`.
- `npm run mcp` runs the thin stdio MCP-to-HTTP adapter for manual debugging; Codex starts it during normal use.
- `npm test` runs the tests. Before the first browser-test run, run `npx playwright install chromium`.
- `npm run build` builds the hosted demo, which contains only a synthetic fixture.

Hosted Sites deployments must remain private, with both `d1` and `r2` set to `null` in `.openai/hosting.json`. The local SQLite database, token, and real transcript are never deployed. The application code loads no remote images, telemetry, or remote fonts.
