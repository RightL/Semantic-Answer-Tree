# Semantic Answer

*Read the answer. Open only the detail you need.*

AI answers are often too short to be useful or too long to scan. Asking “explain that,” “make it longer,” or “make it shorter” over and over is an annoying way to find the right amount of detail.

Semantic Answer gives you one concise, complete answer. Optional explanation is attached to the exact words that may need it: open a short definition in place or a longer detail in a side rail on desktop and a sheet on smaller screens. Opening detail never calls the model or replaces the answer.

The default product is local-first. The transcript service, SQLite database, capability token, and viewer all run on your machine. A hosted Sites build is a private demonstration containing synthetic data only.

## Answer format

The sole public document format is `SemanticAnswer` v1:

```json
{
  "version": 1,
  "title": "A useful title",
  "body": "A concise, complete Markdown answer with [an optional explanation](zoom:why).",
  "expansions": {
    "why": {
      "kind": "detail",
      "title": "Why this works",
      "content": "The additional explanation."
    }
  }
}
```

`expansions` is optional. Each expansion has `kind: "definition"` or `kind: "detail"`, an optional plain-text `title`, and Markdown `content`. An answer body refers to it with `[visible text](zoom:id)`. Definitions open as popovers; details open in a right rail or bottom sheet. Expansion content cannot contain another `zoom:` link.

The body must stand on its own. Important conclusions and decision-changing caveats stay visible in the body; expansions add explanation, evidence, examples, or implementation detail without repairing an incomplete answer.

## Codex session identity

No hook is required. On its first Semantic Answer call in a Codex session, the agent chooses one opaque `sessionId` and reuses it for every publication and history read in that session. A side chat chooses a different ID. The MCP adapter handles turn-level idempotency internally.

## Quick start

Node.js `>=22.13.0` is required.

```powershell
npm ci
npm run local
```

In another PowerShell terminal:

```powershell
npm run dev
```

Open [http://localhost:4173](http://localhost:4173). The local API listens on `http://127.0.0.1:4318` by default. Runtime data stays in the ignored `.semantic-answer/` directory:

- `.semantic-answer/semantic-transcript.sqlite3`
- `.semantic-answer/capability-token`

Linux is also supported. The [setup guide](docs/SETUP.md) includes native Bash commands, Codex MCP registration, the fixed-session-ID convention, and a private two-port SSH tunnel from Windows to `lzt@10.21.1.228`.

## Documentation

- [Setup guide](docs/SETUP.md): Windows, Linux, the `10.21.1.228` tunnel, MCP registration, fixed session IDs, skill installation, tokens, API use, and troubleshooting.
- [Design](docs/DESIGN.md): the answer contract, append-only transcript, sessions, idempotency, authentication, events, and privacy boundaries.
- [`semantic-answer-final`](semantic-answer-final/SKILL.md): concise publishing guidance for Codex.

## Common commands

- `npm run local` starts the loopback HTTP service that owns SQLite, validation, database migrations, and server-sent events.
- `npm run dev` starts the viewer at `http://localhost:4173`.
- `npm run mcp` runs the thin standard-input/output MCP adapter for manual debugging. Codex starts it during normal use.
- `npm test` runs unit and browser tests. Before the first browser-test run, use `npx playwright install chromium`.
- `npm run build` builds the hosted synthetic demonstration.

Hosted Sites deployments must remain private, with both `d1` and `r2` set to `null` in `.openai/hosting.json`. The local database, capability token, and real transcript are never deployed. The repository remains at [RightL/Semantic-Answer-Tree](https://github.com/RightL/Semantic-Answer-Tree) until its address is renamed.
