---
name: semantic-zoom-final
description: >
  Publish the final response to the local Semantic Answer Tree transcript as
  one precomputed SemanticAnswer v1 tree with optional inline term
  explanations. Use when publish_semantic_answer is available and the final
  answer should support independent structural and lexical expansion.
---

# Semantic Answer Tree

Produce one complete answer for the Semantic Answer Tree viewer. Generate all
branches and term definitions before publishing; opening them never calls a
model.

## Prior transcript context

When the request depends on an earlier viewer answer that is not reliably in
context, read compact same-session history. Read at most one full historical
turn selected from that compact result, and only when its hidden detail is
necessary. Do not load large history windows by default.

## Request summary

Write `requestSummary` as one or two concise sentences describing what the user
asked in this turn. Preserve the main request, important constraints, and
explicit exclusions; remove repetition and incidental conversational wording.
Summarize the request, not the answer.

## Semantic tree

Use the exact document shape required by `publish_semantic_answer`. Keep
transport and session metadata outside the document.

The root must directly answer the main question without expansion. A simple
answer may contain only the root.

For every node:

- make its content understandable while the node is collapsed;
- make it an accurate compression of its entire subtree;
- use children only for independently useful resolution such as explanation,
  evidence, mechanism, comparison, implementation, risk, or validation;
- never let children replace, contradict, silently qualify, or merely repeat
  the parent;
- give siblings distinct reading purposes;
- expose any decision-changing caveat in the parent where the decision appears.

Use only as much depth as creates a meaningful choice about what the reader may
skip or inspect. Do not create decorative branches or equalize branch depth.
Hidden content is still generated content, so keep detail proportional to the
request.

## Lexical zoom

Mark a locally opaque phrase with `[visible phrase](term:term-id)` and define it
contextually in the document's top-level `terms` map. Lexical zoom may appear
in any node at any structural depth. Use it for technical terms, method names,
symbols, abbreviations, or phrases with a specific local meaning.

A definition should briefly answer "What does this phrase mean here?" Prefer
one to three concise sentences. Do not recursively mark terms inside a
definition, define each referenced ID once, omit unused definitions, and
annotate only when the explanation improves readability.

Do not hide reasoning, evidence, recommendations, caveats, failure modes, or
substantial comparisons inside definitions; those belong in structural nodes.

## Non-duplication

The root gives the answer-level synthesis. A parent gives the compressed result
of its subtree. Children begin where the parent stops. Do not duplicate content
between parents and children, across sibling branches, or between the viewer
and the ordinary Codex final response.

## Publish and finish

Publish one logical turn with `requestSummary` and the complete document. The
integration owns identity, idempotency, validation, transport, acknowledgement
checks, and ambiguous-delivery recovery; do not invent those values unless the
tool explicitly requires them.

A one-off side chat without stable conversation identity may be bound by the
integration to an isolated Temporary session. Publish normally through that
binding; never guess or reuse the main task's identity. The temporary session
is separate from the main transcript.

After confirmed success, emit only:

```text
Rendered in Semantic Answer Tree.
```

Do not also print the answer, raw JSON, a glossary, or an abbreviated copy.

If the tool returns a correctable document-validation error, repair only the
reported issue and retry once. If publication is not confirmed, return the
complete answer normally in the Codex conversation and do not claim it was
rendered.

Before publishing, verify that the root answers directly, each collapsed node
is meaningful, children add rather than repeat, important caveats appear early,
every `term:` reference has a useful definition, and no detail is unnecessary.
