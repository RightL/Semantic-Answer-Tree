# Semantic Answer Setup Guide

*Read the answer. Open only the detail you need.*

AI answers are often too short or too long, and repeated “explain,” “longer,” and “shorter” turns are an awkward way to control detail. Semantic Answer publishes a concise, complete Markdown answer with optional explanation attached exactly where a reader may want it.

The default installation is local-first. Every successful publication becomes an immutable turn in a local transcript. Session identity, request summaries, idempotency, and authentication belong to the publication protocol; they are not fields in the `SemanticAnswer` v1 document.

## 1. Install and start

Requirements:

- Node.js `>=22.13.0`.
- Codex CLI for registering the local MCP adapter.
- Chromium for browser tests. Before the first browser-test run, use `npx playwright install chromium`.

### Windows

From the project root:

```powershell
npm ci
npm run local
```

The API listens on `http://127.0.0.1:4318`. On first start it creates the SQLite database, applies database migrations, and creates a capability-token file unless a token was supplied directly.

Check it from another terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:4318/health
```

Start the viewer in that second terminal:

```powershell
npm run dev
```

Open [http://localhost:4173](http://localhost:4173). The viewer lists sessions and immutable turns. A committed `turn-published` event contains identifiers only; the viewer then reads the turn.

### Linux

From the project root:

```bash
node --version
npm ci
```

Do not continue with an older distribution-provided Node.js release. Install a current user-scoped Node.js release first if needed.

Run the API and viewer in separate terminals:

```bash
# Terminal 1
npm run local
```

```bash
# Terminal 2
npm run dev
```

Both processes bind to loopback. Open `http://localhost:4173` on that Linux machine.

### View `10.21.1.228` privately from Windows

Keep the Linux listeners private and forward both through SSH. The following layout lets a Windows installation remain on ports `4173` and `4318` while the server appears on Windows ports `4174` and `4319`.

On `lzt@10.21.1.228`, build the viewer for the Windows-side API port:

```bash
export PROJECT_ROOT="$(pwd -P)"
export SEMANTIC_ANSWER_DB="$PROJECT_ROOT/.semantic-answer/semantic-transcript.sqlite3"
export SEMANTIC_ANSWER_TOKEN_FILE="$PROJECT_ROOT/.semantic-answer/capability-token"
export SEMANTIC_ANSWER_VIEWER_ORIGINS="http://localhost:4174,http://127.0.0.1:4174"
export NEXT_PUBLIC_SEMANTIC_ANSWER_API="http://127.0.0.1:4319"
npm run build
```

Start the API and production viewer on the server:

```bash
# Linux terminal 1
export PROJECT_ROOT="$(pwd -P)"
export SEMANTIC_ANSWER_DB="$PROJECT_ROOT/.semantic-answer/semantic-transcript.sqlite3"
export SEMANTIC_ANSWER_TOKEN_FILE="$PROJECT_ROOT/.semantic-answer/capability-token"
export SEMANTIC_ANSWER_VIEWER_ORIGINS="http://localhost:4174,http://127.0.0.1:4174"
npm run local
```

```bash
# Linux terminal 2
npm run start
```

Keep this PowerShell command running on Windows:

```powershell
ssh -N -T `
  -o ExitOnForwardFailure=yes `
  -o ServerAliveInterval=30 `
  -o ServerAliveCountMax=3 `
  -L 4174:127.0.0.1:4173 `
  -L 4319:127.0.0.1:4318 `
  lzt@10.21.1.228
```

Open [http://localhost:4174](http://localhost:4174) on Windows. The browser calls `http://127.0.0.1:4319`; both connections pass through SSH to server loopback listeners. If either Windows-side port changes, update `NEXT_PUBLIC_SEMANTIC_ANSWER_API`, rebuild the viewer, update `SEMANTIC_ANSWER_VIEWER_ORIGINS`, and restart the services.

Never expose server port `4318` or `4173` to the LAN or internet. Several transcript-reading routes intentionally do not require the capability token because the service is designed for a single user's loopback environment.

## 2. Runtime paths, tokens, and environment variables

The defaults work from the project root. For regular use, prefer absolute database and token paths and point the HTTP service and MCP adapter at the same token file.

| Environment variable | Default | Consumer and purpose |
| --- | --- | --- |
| `SEMANTIC_ANSWER_DB` | `.semantic-answer/semantic-transcript.sqlite3` | SQLite database used by the HTTP service. The MCP adapter also uses it to derive the default token-file path. |
| `SEMANTIC_ANSWER_TOKEN` | Not set | HTTP service or MCP adapter. Supplies the capability token directly and takes precedence over the token file. |
| `SEMANTIC_ANSWER_TOKEN_FILE` | `capability-token` beside the database | HTTP service or MCP adapter. Provides their shared token. |
| `SEMANTIC_ANSWER_SERVICE_URL` | `http://127.0.0.1:4318` | MCP adapter. Must be a loopback HTTP origin with no path, query, or credentials. |
| `SEMANTIC_ANSWER_PORT` | `4318` | HTTP service listening port. |
| `NEXT_PUBLIC_SEMANTIC_ANSWER_API` | `http://127.0.0.1:4318` | Origin from which the viewer reads sessions, turns, and events. Set before development startup or production build. |
| `SEMANTIC_ANSWER_VIEWER_ORIGINS` | `http://localhost:4173,http://127.0.0.1:4173` | Exact viewer origins allowed by the HTTP service, separated by commas. |

Relative paths resolve against the process working directory. This PowerShell example sets values only for the current terminal:

```powershell
$projectRoot = (Get-Location).Path
$runtimeRoot = Join-Path $projectRoot ".semantic-answer"
$env:SEMANTIC_ANSWER_DB = Join-Path $runtimeRoot "semantic-transcript.sqlite3"
$env:SEMANTIC_ANSWER_TOKEN_FILE = Join-Path $runtimeRoot "capability-token"
npm run local
```

After trimming, `SEMANTIC_ANSWER_TOKEN` must contain at least 32 characters and no whitespace. Never pass it through a `NEXT_PUBLIC_*` variable or put it in an answer, request summary, log, or Git. The token file uses mode `0600` where POSIX modes are supported. Windows does not guarantee POSIX permission bits, so keep the runtime directory in a private user workspace.

For a custom API port, keep every consumer consistent:

```powershell
# HTTP service terminal
$env:SEMANTIC_ANSWER_PORT = "4319"
npm run local
```

```powershell
# Viewer terminal
$env:NEXT_PUBLIC_SEMANTIC_ANSWER_API = "http://127.0.0.1:4319"
npm run dev
```

The MCP adapter must use `SEMANTIC_ANSWER_SERVICE_URL=http://127.0.0.1:4319`. If the viewer origin changes, add its complete origin to `SEMANTIC_ANSWER_VIEWER_ORIGINS`; wildcards are not accepted.

## 3. Register the MCP adapter

`server/mcp-server.mjs` calls the loopback HTTP service and never opens SQLite directly. Run `npm run local` once so the default token file exists.

On Windows PowerShell:

```powershell
$nodePath = (Get-Command node).Source
$mcpPath = (Resolve-Path .\server\mcp-server.mjs).Path
$serviceUrl = "http://127.0.0.1:4318"
$tokenFile = Join-Path (Get-Location).Path ".semantic-answer\capability-token"

codex mcp add semantic-answer `
  --env "SEMANTIC_ANSWER_SERVICE_URL=$serviceUrl" `
  --env "SEMANTIC_ANSWER_TOKEN_FILE=$tokenFile" `
  -- $nodePath $mcpPath

codex mcp list
```

On Linux Bash:

```bash
PROJECT_ROOT="$(pwd -P)"
NODE_PATH="$(command -v node)"
MCP_PATH="$(realpath server/mcp-server.mjs)"
TOKEN_FILE="$PROJECT_ROOT/.semantic-answer/capability-token"

codex mcp add semantic-answer \
  --env "SEMANTIC_ANSWER_SERVICE_URL=http://127.0.0.1:4318" \
  --env "SEMANTIC_ANSWER_TOKEN_FILE=$TOKEN_FILE" \
  -- "$NODE_PATH" "$MCP_PATH"

codex mcp list
```

On `10.21.1.228`, Codex and its MCP adapter call the server's own `http://127.0.0.1:4318`; the Windows-side port `4319` is only for the tunneled browser.

Restart Codex, then use `/mcp` to check `semantic-answer`. Codex CLI, the desktop application, and the IDE extension share MCP configuration when they run on the same Codex host. See the [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

The adapter exposes three tools:

| Tool | Purpose |
| --- | --- |
| `publish_semantic_answer` | Validates and appends one turn. Success returns `{ ok: true, sessionId, turnId, sequence }`, not the answer. |
| `read_semantic_history` | Reads compact `{ version, title, body }` previews for the supplied session ID. |
| `read_semantic_turn` | Reads one complete immutable turn by `turnId`. |

Read a small history page first. Read at most one complete prior turn, and only when its expansion content is needed. Do not automatically load large history windows or multiple complete turns.

## 4. Use one fixed session ID

No Codex hook or identity configuration is required.

At the first Semantic Answer call in a Codex session, the agent chooses one opaque `sessionId`, such as `sa-` followed by a random UUID. It keeps that exact value in the session context and supplies it to every `publish_semantic_answer` and `read_semantic_history` call in that session.

A side chat chooses its own `sessionId`; it never copies the main task's ID. The ID is deliberately independent of Codex task metadata, process IDs, working directories, browser tabs, and the viewer's latest session.

The MCP adapter creates idempotency metadata internally for each publication and reuses it only for its bounded ambiguous-delivery retry. The agent supplies no turn key or idempotency key.

## 5. Install `semantic-answer-final`

From the project root on Windows:

```powershell
$userProfile = [Environment]::GetFolderPath("UserProfile")
$skillTarget = Join-Path $userProfile ".agents\skills\semantic-answer-final"
New-Item -ItemType Directory -Force $skillTarget | Out-Null
Copy-Item .\semantic-answer-final\* $skillTarget -Recurse -Force
```

On Linux:

```bash
SKILL_TARGET="$HOME/.agents/skills/semantic-answer-final"
mkdir -p "$SKILL_TARGET"
cp -a semantic-answer-final/. "$SKILL_TARGET/"
```

Restart Codex if the skill does not appear. See the [official Skills documentation](https://developers.openai.com/codex/skills).

```text
Use $semantic-answer-final to publish the final answer to Semantic Answer.
```

The skill chooses and retains one `sessionId` for the Codex session, keeps the main body concise and complete, uses sparse `[visible text](zoom:id)` anchors, and keeps decision-changing caveats visible. After durable `{ ok: true, sessionId, turnId, sequence }` acknowledgement, it outputs only:

```text
Rendered in Semantic Answer.
```

It may repair one reported document-validation issue. Ambiguous delivery recovery happens in the adapter, which retries once with the identical serialized envelope and a ten-second deadline for each loopback attempt. If durable publication cannot be confirmed, Codex gives the complete answer in the conversation and does not claim success.

## 6. HTTP API and answer contract

Routes:

| Method and path | Authentication | Purpose |
| --- | --- | --- |
| `GET /health` | None | Returns `{ ok: true }` when the service is reachable. |
| `GET /api/sessions` | None | Lists viewer sessions. |
| `GET /api/sessions/:id/turns?beforeSequence=&afterSequence=&limit=20` | None | Reads one paginated transcript. |
| `GET /api/turns/:id` | None | Reads one complete immutable turn. |
| `GET /api/history?sessionId=&beforeSequence=&limit=` | Bearer | Reads compact answer previews for an agent. |
| `POST /api/publish` | Bearer | Validates and appends a publication envelope. |
| `GET /events` | None | Sends `ready`, then identifier-only `turn-published` events and heartbeats. |

Protected routes use:

```http
Authorization: Bearer <token>
```

This is a single-user loopback viewer, not tenant isolation. The token protects publishing and agent history reads. Session lists, complete turns, and events are unauthenticated loopback reads required by the viewer. Any process that can directly reach the local service can read the transcript. Request summaries and answers are plaintext in SQLite; append-only storage is not encryption or per-session authorization.

The sole document format is:

```ts
type SemanticAnswer = {
  version: 1;
  title: string;
  body: string;
  expansions?: Record<string, {
    kind: "definition" | "detail";
    title?: string;
    content: string;
  }>;
};
```

An inline `[visible span](zoom:expansion-id)` in `body` opens the matching expansion. Definitions appear in accessible popovers. Details appear in a fixed right rail on desktop and a bottom sheet at narrower widths. Only one expansion is open at a time. `Copy body` copies the visible answer; `Copy complete` includes expansion content.

The body must be useful by itself. Every stored expansion must be referenced, every reference must resolve, and expansion content cannot contain another `zoom:` link. Links inside code spans and fenced code blocks are treated as examples rather than anchors. Expansion identifiers use lowercase ASCII letters, digits, `.`, `_`, and `-`.

The publication endpoint accepts a complete envelope, not a bare document:

```json
{
  "sessionId": "sa-conversation-123",
  "requestSummary": "The user asked for a concise comparison of two solver choices.",
  "document": {
    "version": 1,
    "title": "Solver comparison",
    "body": "Choose A for the default case. [Why](zoom:why-a)",
    "expansions": {
      "why-a": {
        "kind": "detail",
        "title": "Why A is the default",
        "content": "A has the lower operating cost under the stated constraints."
      }
    }
  },
  "idempotencyKey": "stable-key-for-this-turn"
}
```

Direct HTTP callers supply all four envelope fields. The MCP adapter accepts only `sessionId`, `requestSummary`, and `document`; it creates `idempotencyKey` internally.

PowerShell publication example:

```powershell
$token = (Get-Content .\.semantic-answer\capability-token -Raw).Trim()
$headers = @{ Authorization = "Bearer $token" }

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:4318/api/publish `
  -Headers $headers `
  -ContentType "application/json; charset=utf-8" `
  -InFile .\publication-envelope.json
```

Successful acknowledgement:

```json
{
  "ok": true,
  "sessionId": "...",
  "turnId": "...",
  "sequence": 7
}
```

Submitting the same idempotency key and identical envelope in one session returns the original acknowledgement without appending or emitting again. Reusing the key for different content returns a conflict.

Turn-page cursors are exclusive and `beforeSequence` and `afterSequence` cannot be combined. Results are ascending. The default and maximum turn-page limits are 20 and 100; history limits are 10 and 50. List, page, single-turn, and history responses use `{ sessions }`, `{ sessionId, turns, hasOlder, hasNewer, oldestSequence, latestSequence }`, `{ turn }`, and `{ session, turns, hasOlder, oldestSequence, latestSequence }`.

An event connection first receives `ready` with `{ "ok": true }`. Each `turn-published` payload contains only `eventId`, `sessionId`, `turnId`, and `sequence`. A known `Last-Event-ID` can replay up to 100 subsequent committed events; an unknown ID triggers no replay.

The service rejects unknown fields, unresolved or unused expansions, nested anchors, oversized input, abnormal identity or summary lengths, and malformed media types. Validation errors contain sanitized paths and messages, never rejected answer text. Markdown is sanitized before rendering.

Common statuses are `400` for an invalid query or envelope, `404` for not found, `405` for an unsupported method, `409` for an idempotency conflict, `413` for an oversized body, `415` for non-JSON media, and `500` for an internal error. Errors use `{ ok: false, error: { code, message, ... } }`.

## 7. Database startup and reset

At startup the service opens `SEMANTIC_ANSWER_DB`, enables foreign keys, a busy timeout, write-ahead logging, and `synchronous=FULL`, then applies each unrecorded `server/migrations/NNN_name.sql` file in order. Each migration and its record commit together; failure rolls back and prevents startup with a partially changed schema.

This release uses only the current linear-answer document contract. For an installation created with a different answer document shape, stop the API and viewer, preserve the capability token, back up the database if desired, remove only the database plus its `-wal` and `-shm` companions, and restart the service to create a fresh transcript. Do not edit immutable turn rows by hand.

With write-ahead logging enabled, stop the service before copying a database or use a SQLite-aware backup instead of copying only the live main file.

## 8. Hosted demonstration and privacy

Hosted Sites deployments must remain private. Both `d1` and `r2` in `.openai/hosting.json` must be `null`. A hosted build reads only synthetic `public/demo-transcript.json`; outside a local hostname the page does not connect to the local API or SQLite.

The application loads no remote images, telemetry, or remote fonts. Runtime data belongs in the ignored `.semantic-answer/` directory. Any overridden database or token path must also remain private, ignored, and outside `public/`.

`npm run build` scans `dist` for known database, token, path, and canary leaks. This is a focused release check, not proof that a bundle can contain no arbitrary private text.

## 9. Troubleshooting

- `401`: make the HTTP service and MCP adapter use the same `SEMANTIC_ANSWER_TOKEN` or absolute `SEMANTIC_ANSWER_TOKEN_FILE`.
- `403 origin_forbidden`: add the exact viewer origin to `SEMANTIC_ANSWER_VIEWER_ORIGINS`.
- `invalid_tool_input` for a missing session: choose one opaque `sessionId` and reuse it for publish and history calls in the current Codex session.
- MCP connects but publishing fails: confirm `npm run local` is running, check `SEMANTIC_ANSWER_SERVICE_URL`, and request `GET /health`.
- A timeout leaves delivery uncertain: let the MCP adapter perform its one identical-envelope retry.
- Database migration fails: fix the cause and restart; do not edit immutable turns.
- Live updates stop: check `GET /events` and `NEXT_PUBLIC_SEMANTIC_ANSWER_API`. Committed turns remain readable.
- Durable acknowledgement is missing: do not output `Rendered in Semantic Answer.` Give the complete answer in the conversation.
