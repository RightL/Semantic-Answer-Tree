---
name: semantic-answer-final
description: >
  Publish a final response to the local Semantic Answer transcript as one
  concise, complete SemanticAnswer v1 body with optional span-anchored
  definitions or details. Use when publish_semantic_answer is available and
  readers should be able to open explanation exactly where they need it.
---

# Semantic Answer

Prepare one answer that is useful before anything is opened. Generate all optional detail before publishing; opening it never calls the model.

## Use prior context sparingly

When an earlier viewer answer is necessary but absent from context, read a small amount of same-session history. Read at most one complete prior turn, and only when its omitted expansion content is needed. Do not load large history windows by default.

## Write the publication

Write `requestSummary` as one or two concise sentences about the current request. Preserve the main request, material constraints, and explicit exclusions; summarize the request, not the answer.

Use the exact `SemanticAnswer` v1 shape required by `publish_semantic_answer`: `version`, `title`, `body`, and optional `expansions`. Keep session and transport metadata outside the document.

Make `body` a concise, complete Markdown answer. It must directly answer the user without expansions. Keep conclusions, recommendations, and every decision-changing caveat visible in the body.

Add expansions only where a likely reader could reasonably want more:

- Mark an exact body span as `[visible text](zoom:id)`.
- Use `kind: "definition"` for a brief contextual meaning suitable for a popover.
- Use `kind: "detail"` for explanation, evidence, comparison, examples, implementation, risk, or validation suited to the detail rail or sheet.
- Make expansion content start where the body stops. Do not repeat, contradict, or silently qualify the body.
- Keep anchors sparse. Do not annotate familiar words or create expansions merely to make the answer look interactive.
- Do not place `zoom:` links inside expansion content. Expansion is one level only.

A simple answer may have no expansions.

## Publish and finish

Publish one logical turn with `requestSummary` and the complete document. The integration owns identity, idempotency, validation, transport, acknowledgement checks, and ambiguous-delivery recovery; do not invent those values unless the tool requires them.

A one-off side chat may receive an isolated `Temporary` session. Publish through that binding and never guess or reuse the main task identity. Temporary describes identity scope; its turn remains in local append-only history.

If publication returns a correctable document-validation error, repair only the reported issue and retry once.

After confirmed success, emit only:

```text
Rendered in Semantic Answer.
```

Do not repeat the answer, JSON, or a shortened copy in the conversation. If durable publication is not confirmed, give the complete answer normally in the conversation and do not claim success.

Before publishing, verify that the body stands alone, important caveats are visible, every anchor resolves, every expansion is used, expansions add rather than repeat, and no expansion contains another anchor.
