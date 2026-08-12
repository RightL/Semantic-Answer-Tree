# Semantic Answer Tree Setup Guide

*Explore every answer, branch by branch*

This local tool stores every successful publication as an immutable turn and groups turns into transcripts by stable source session. The public answer still uses the `SemanticAnswer` schema v1. Session identity, turn identity, request summaries, idempotency, and authentication exist only in the surrounding publication protocol.

## 1. Installation and Startup

Requirements:

- Node.js `>=22.13.0`.
- Codex CLI, used to register the local stdio MCP server.
- Chromium for browser tests. Before the first browser-test run, install it with `npx playwright install chromium`.

Install dependencies from the project root:

```powershell
npm install
```

Start the local transcript service in the first terminal:

```powershell
npm run local
```

The service listens on `http://127.0.0.1:4318` by default. On its first start, it creates the SQLite database, applies migrations, and creates a capability-token file unless a token was provided directly.

```powershell
Invoke-RestMethod http://127.0.0.1:4318/health
```

Start the dedicated viewer in the second terminal:

```powershell
npm run dev
```

Open [http://localhost:4173](http://localhost:4173). The viewer shows the session list and immutable turns. A new `turn-published` event carries IDs only; the page then reads the committed turn.

## 2. Runtime Paths, Tokens, and Environment Variables

The defaults work when commands run from the project root. For regular local use, resolve both the database and token-file paths to absolute paths, and point the HTTP service and MCP adapter at the same token file.

| Environment variable | Default | Consumer and purpose |
| --- | --- | --- |
| `SEMANTIC_ANSWER_DB` | `.semantic-answer/semantic-transcript.sqlite3` | SQLite database used by the HTTP service. The MCP adapter also uses it to derive the default token-file path. |
| `SEMANTIC_ANSWER_LEGACY_FILE` | Not set | HTTP service. Only when explicitly set does the service attempt a one-time import of the specified legacy schema-v1 file. |
| `SEMANTIC_ANSWER_TOKEN` | Not set | HTTP service or MCP adapter. Supplies the capability token directly and takes precedence over the token file. |
| `SEMANTIC_ANSWER_TOKEN_FILE` | `capability-token` in the database directory | HTTP service or MCP adapter. Provides their shared token. |
| `SEMANTIC_ANSWER_SERVICE_URL` | `http://127.0.0.1:4318` | MCP adapter. Must be a loopback HTTP origin with no path, query, or credentials. |
| `SEMANTIC_ANSWER_PORT` | `4318` | HTTP service listening port. |
| `NEXT_PUBLIC_SEMANTIC_ANSWER_API` | `http://127.0.0.1:4318` | Origin from which the viewer reads sessions, turns, and SSE. Set it before startup or build. |
| `SEMANTIC_ANSWER_SESSION_KEY` | Not set | Explicit MCP binding for one conversation, used only when a hook or wrapper is unavailable. |
| `SEMANTIC_ANSWER_TURN_KEY` | Not set | Optional turn binding for a dedicated wrapper. It must differ for every logical turn and must not be reused statically. |
| `SEMANTIC_ANSWER_VIEWER_ORIGINS` | `http://localhost:4173,http://127.0.0.1:4173` | Exact viewer origins allowed by the HTTP service, separated by commas. |

Relative paths are resolved against the current working directory of the process being started. The following PowerShell sets environment variables only for the current terminal and does not write user configuration:

```powershell
$projectRoot = (Get-Location).Path
$runtimeRoot = Join-Path $projectRoot ".semantic-answer"
$env:SEMANTIC_ANSWER_DB = Join-Path $runtimeRoot "semantic-transcript.sqlite3"
$env:SEMANTIC_ANSWER_TOKEN_FILE = Join-Path $runtimeRoot "capability-token"
npm run local
```

Default startup does not read any legacy file. Only when migrating an older installation should you set `SEMANTIC_ANSWER_LEGACY_FILE` to the old schema-v1 file before starting the service. Never copy a real legacy file into `public/`.

After trimming, `SEMANTIC_ANSWER_TOKEN` must contain at least 32 characters. A valid Bearer token cannot contain whitespace. Never pass a token through a `NEXT_PUBLIC_*` variable, and never put it in an answer, request summary, log, or Git. The token file uses mode `0600` on systems that support POSIX modes. Windows does not guarantee that POSIX permission bits are exposed, so keep the runtime directory in a private user workspace.

When using a custom port, keep both terminals consistent:

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

The registered MCP adapter must also set `SEMANTIC_ANSWER_SERVICE_URL` to `http://127.0.0.1:4319`; then restart Codex. The `$serviceUrl` value in the registration command in section 3 is this independent setting. To run the adapter manually, set it in that terminal:

```powershell
$env:SEMANTIC_ANSWER_SERVICE_URL = "http://127.0.0.1:4319"
npm run mcp
```

If the viewer origin also changes, add the new origin to `SEMANTIC_ANSWER_VIEWER_ORIGINS`. This variable accepts only complete, exact loopback HTTP or HTTPS origins; it does not accept wildcards.

## 3. Register the Thin MCP Adapter

`server/mcp-server.mjs` does not open SQLite directly. It calls the single HTTP service through `SEMANTIC_ANSWER_SERVICE_URL` and the capability token.

Run `npm run local` once so that the default token file exists.

If `semantic-answer-viewer` is already registered, remove it once before adding the new registration:

```powershell
codex mcp remove semantic-answer-viewer
```

Then resolve absolute paths and register the adapter from the project root:

```powershell
$nodePath = (Get-Command node).Source
$mcpPath = (Resolve-Path .\server\mcp-server.mjs).Path
$serviceUrl = "http://127.0.0.1:4318"
$tokenFile = Join-Path (Get-Location).Path ".semantic-answer\capability-token"

codex mcp add semantic-answer-tree `
  --env "SEMANTIC_ANSWER_SERVICE_URL=$serviceUrl" `
  --env "SEMANTIC_ANSWER_TOKEN_FILE=$tokenFile" `
  -- $nodePath $mcpPath

codex mcp list
```

The registration name is mutable. Because it is part of each fully qualified MCP tool name, this one-time rename also requires changing the hook matcher to the pattern in section 4 and reviewing and trusting the updated hook again.

Restart Codex, then use `/mcp` to check `semantic-answer-tree`. Codex CLI, the desktop application, and the IDE extension share MCP configuration when they run on the same Codex host. See the [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) for the official configuration reference.

The MCP server exposes three tools:

| Tool | Purpose |
| --- | --- |
| `publish_semantic_answer` | Validates and appends one turn. On success, it returns `{ ok: true, sessionId, turnId, sequence }`, not the answer. |
| `read_semantic_history` | Reads compact `roots` or `frontier` history for the current source session. |
| `read_semantic_turn` | Reads one complete immutable turn by `turnId`. |

Call `read_semantic_history` first with a small limit and compact detail. Call `read_semantic_turn` at most once, and only when the compact information is insufficient. Do not automatically read a large history or multiple full turns.

In compact history, each root node contains only `content`, `childCount`, and, in `frontier` mode, an optional single level of `children`. `answer.terms` contains definitions only for terms referenced by the returned nodes. Compact history does not return the full tree and does not replace definitions with term IDs.

## 4. Configure the Codex Session Hook

A normal stdio MCP configuration records command, arguments, environment, and current working directory, but the official documentation does not say that it automatically forwards the current Codex thread ID into tool arguments. Therefore, one MCP process must not be assumed to represent one conversation.

The preferred solution is the included `integration/codex-session-hook.mjs`. The repository neither includes nor automatically installs a user-level `hooks.json`; users must manually review and merge the configuration.

Use this exact hook matcher:

```text
^mcp__semantic-answer-tree__(publish_semantic_answer|read_semantic_history)$
```

During `PreToolUse`, the hook reads the Codex common `session_id`, the turn-scoped `turn_id`, and the MCP `tool_input`. It then injects the following values through `updatedInput`, overriding fields with the same names supplied by the model:

```text
sourceSessionKey = "codex:" + session_id
sourceTurnKey    = turn_id
idempotencyKey  = SHA-256("codex:" + session_id + ":" + turn_id)
```

The hook does not read transcripts, files, or the network. It reads only hook standard input and hashes IDs. First obtain absolute command paths, then have PowerShell print mergeable JSON. These commands do not write to the user home directory:

```powershell
$nodePath = (Get-Command node).Source
$hookPath = (Resolve-Path .\integration\codex-session-hook.mjs).Path
$hookCommand = '"{0}" "{1}"' -f $nodePath, $hookPath

$hookConfig = [ordered]@{
  description = "Bind Semantic Answer Tree calls to the current Codex session and turn."
  hooks = [ordered]@{
    PreToolUse = @(
      [ordered]@{
        matcher = "^mcp__semantic-answer-tree__(publish_semantic_answer|read_semantic_history)$"
        hooks = @(
          [ordered]@{
            type = "command"
            command = $hookCommand
            commandWindows = $hookCommand
            timeout = 5
          }
        )
      }
    )
  }
}

$hookConfig | ConvertTo-Json -Depth 10
```

Merge the output into the user-level `~/.codex/hooks.json` or the `.codex/hooks.json` of a trusted project. The command must retain absolute paths for both Node and the script because the hook runs from the session's current working directory. Register the MCP server with the exact name `semantic-answer-tree`, or the matcher will not match.

A non-managed command hook must be reviewed and trusted. After restarting Codex, run `/hooks` and verify the source, matcher, command, and script contents before trusting the exact definition. Any change to the hook definition requires another review. A project hook also requires trusting that project's `.codex` configuration layer. Do not use bypass trust for routine configuration, and do not configure another hook that rewrites the same calls. See the [Codex Hooks documentation](https://learn.chatgpt.com/docs/hooks) for details about inputs, `updatedInput`, and trust.

If hook input lacks `session_id` or `turn_id`, the included script passes through the original arguments instead of inventing identity. The MCP server or service then rejects missing identity or idempotency unless you have configured the explicit session binding below and supplied a reusable idempotency key explicitly for that turn.

### Alternative Identity Strategies

- App Server wrapper: use the returned `thread.id` as the source conversation key and `turn.id` as the source turn key. Do not use `thread.sessionId` as fork identity. A persistent fork has a new `thread.id` but retains the root `thread.sessionId`. See the [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).
- Explicit fallback: only when neither a hook nor a wrapper is available, set a unique `SEMANTIC_ANSWER_SESSION_KEY` in an MCP configuration dedicated to that conversation. This is a manual binding; it does not automatically follow a thread, fork, or new conversation.

The implementation also accepts `SEMANTIC_ANSWER_TURN_KEY`, but its value must change with every logical turn. Never set it statically in a reused MCP configuration, or it will cause `source_turn_conflict`. For the normal fallback, provide the source turn and idempotency key directly in that turn's tool arguments.

Never derive identity from the current working directory, process ID, browser tab, or a "latest session" concept.

## 5. Install and Use `semantic-zoom-final`

Install the skill into the user-level directory from the project root:

```powershell
$userProfile = [Environment]::GetFolderPath("UserProfile")
$skillTarget = Join-Path $userProfile ".agents\skills\semantic-zoom-final"
New-Item -ItemType Directory -Force $skillTarget | Out-Null
Copy-Item .\semantic-zoom-final\* $skillTarget -Recurse -Force
```

Codex normally discovers the skill automatically. Restart Codex if it does not appear. See the [official Skills documentation](https://developers.openai.com/codex/skills) for location and discovery rules.

```text
Use $semantic-zoom-final to publish the final answer to Semantic Answer Tree.
```

The skill:

1. Reads compact history only when prior context is needed and reads at most one full prior turn.
2. Generates a one- or two-sentence `requestSummary` that describes the current user request without restating the answer.
3. Generates a complete `SemanticAnswer` v1 tree. Its structural and lexical-zoom rules are unchanged.
4. Obtains source keys and a deterministic idempotency key through the hook, then publishes one logical envelope.
5. Outputs the following exact final status only after receiving the durable `{ ok: true, sessionId, turnId, sequence }` acknowledgment:

```text
Rendered in Semantic Answer Tree.
```

After a successful publication, the normal final response must not repeat the answer body, JSON, a Markdown summary, or a glossary.

After a validation rejection, the skill makes one correction based only on the structured issue and retries once with the same idempotency key. If a timeout leaves the commit status unknown, it retries once with exactly the same envelope and key. A retry of an already committed publication returns the original acknowledgment without appending a turn or sending a second event. If a durable acknowledgment still cannot be confirmed, the skill does not output the rendered status and instead gives the complete ordinary answer in the current conversation.

## 6. HTTP API and Fallback

The local API provides these routes:

| Method and path | Authentication | Purpose |
| --- | --- | --- |
| `GET /health` | None | Checks whether the service is reachable. Success returns only `{ ok: true }`. |
| `GET /api/sessions` | None | Lists viewer sessions. |
| `GET /api/sessions/:id/turns?beforeSequence=&afterSequence=&limit=20&detail=full` | None | Reads one paginated session of turns. |
| `GET /api/turns/:id?detail=full` | None | Reads one full immutable turn. |
| `GET /api/history?sourceSessionKey=&beforeSequence=&limit=&detail=roots|frontier` | Bearer | Lets an agent read compact history. |
| `POST /api/publish` | Bearer | Validates and appends a complete publication envelope. |
| `GET /events` | None | SSE stream. It sends `ready` first, followed by `turn-published` events and heartbeats. |

Protected routes use:

```http
Authorization: Bearer <token>
```

This is a single-user loopback viewer, not tenant isolation. The service refuses to bind to any host other than `127.0.0.1`. The token protects publishing and compact history, while the session list, full turns, and SSE remain unauthenticated loopback reads required by the viewer. Any process that can make direct local requests can read the entire transcript. Request summaries and answers are plaintext in SQLite; append-only storage does not provide encryption or per-session authorization.

The turn page's `beforeSequence` and `afterSequence` values are exclusive cursors and cannot be supplied together. Results are returned in ascending sequence order. The default and maximum turn-page limits are 20 and 100. The default and maximum history limits are 10 and 50, and its default `detail` is `roots`. Viewer turn detail defaults to `full` when omitted. List, page, and single-turn responses respectively use `{ sessions }`, `{ sessionId, turns, hasOlder, hasNewer, oldestSequence, latestSequence }`, and `{ turn }`. History returns `{ session, turns, hasOlder, oldestSequence, latestSequence, detail }`.

The HTTP fallback must submit a complete envelope with `application/json`, not a bare `SemanticAnswer`. `sourceTurnKey` may be omitted. The other four fields are required in the resolved service envelope:

```json
{
  "sourceSessionKey": "manual:conversation-123",
  "sourceTurnKey": "turn-7",
  "requestSummary": "The user asked for a concise comparison of two solver choices.",
  "document": {
    "version": 1,
    "title": "Solver comparison",
    "root": {
      "content": "..."
    }
  },
  "idempotencyKey": "stable-key-for-this-turn"
}
```

PowerShell example:

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

Successful acknowledgment:

```json
{
  "ok": true,
  "sessionId": "...",
  "turnId": "...",
  "sequence": 7
}
```

An SSE connection first receives a `ready` event whose payload is `{ "ok": true }`. Each later `turn-published` payload contains exactly `eventId`, `sessionId`, `turnId`, and `sequence`, with no answer body. Given a known `Last-Event-ID`, a client can replay up to 100 subsequent committed events. An unknown ID causes no replay.

The service rejects unknown envelope fields, an oversized HTTP body, and abnormal session, idempotency, or request-summary lengths. Schema-v1 validation also limits tree depth, node count, per-node Markdown, total document size, term count, and term ID and definition sizes. Validation responses contain only sanitized structured issues. The viewer sanitizes Markdown, and expanding a node or term never calls the model.

Common HTTP statuses are `400` for an invalid query or envelope, `404` for not found, `405` for an unsupported method, `409` for an idempotency or source-turn conflict, `413` for an oversized body, `415` for a non-JSON media type, and `500` for an internal error. The error envelope is `{ ok: false, error: { code, message, ... } }` and never echoes a rejected answer value.

## 7. Legacy Import and Database Migrations

When the HTTP service starts, it automatically:

1. Opens `SEMANTIC_ANSWER_DB`.
2. Enables foreign keys, a busy timeout, WAL, and `synchronous=FULL`.
3. Applies every unrecorded `server/migrations/NNN_name.sql` migration in order.

The service does not read a legacy file by default. It attempts to read one only when `SEMANTIC_ANSWER_LEGACY_FILE` is explicitly set, and it skips the import if that file does not exist. A valid schema-v1 file is read without modification and imported once into a fixed imported session. The absolute source path is stored in the import marker, so the same path is never imported twice. The original file is not moved, deleted, or rewritten. Invalid legacy JSON or schema does not contaminate the database; startup continues, and the invalid status remains only in the service's internal import result.

See [Design and Migration](DESIGN-MIGRATION.md) for transaction, immutable-turn, and backup details.

## 8. Hosted Demo and Privacy

Hosted Sites deployments must remain private, and both `d1` and `r2` in `.openai/hosting.json` must be `null`. The hosted build reads only the synthetic `public/demo-transcript.json`; a non-localhost page never connects to the local API or SQLite.

The application code loads no remote images, telemetry, or remote fonts. The default runtime directory is the ignored `.semantic-answer/`. If you override the database, legacy, or token path, the configured path must also remain private and ignored and must not be copied into `public/`. The hosted demo and private local data use separate data paths.

`npm run build` applies a privacy scan to `dist` for known database, token, path, and canary leaks. This is a targeted release gate, not proof that arbitrary private text can never enter a bundle.

## 9. Troubleshooting

- `401`: confirm that the HTTP service and MCP adapter use the same `SEMANTIC_ANSWER_TOKEN` or the same absolute `SEMANTIC_ANSWER_TOKEN_FILE`.
- `403 origin_forbidden`: add the actual viewer origin exactly to `SEMANTIC_ANSWER_VIEWER_ORIGINS`.
- `missing_session_identity`: enable and trust the included hook. Use `SEMANTIC_ANSWER_SESSION_KEY` only when you explicitly accept a manual binding.
- Hook does not run: use `/hooks` to inspect the source, matcher, hash, and trust status. Confirm that the matcher matches `mcp__semantic-answer-tree__...`.
- MCP connects but publishing fails: confirm that `npm run local` is running, verify `SEMANTIC_ANSWER_SERVICE_URL`, and request `GET /health`.
- A timeout leaves the write uncertain: retry only with the same envelope and idempotency key; do not generate a new key.
- Migration fails: the service will not continue with a partially migrated schema. Fix the cause and restart it; do not manually edit immutable turns.
- The viewer does not update live: check `GET /events` and `NEXT_PUBLIC_SEMANTIC_ANSWER_API`. Committed data remains available through the session and turn APIs.
- Codex does not receive a durable acknowledgment: do not output `Rendered in Semantic Answer Tree.` Give the complete answer in the conversation instead.
