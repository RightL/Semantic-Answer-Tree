---
name: semantic-zoom-final
description: >
  Publish the final response as one precomputed SemanticAnswer v1 tree in the
  durable multi-session Semantic Answer Tree transcript. The tree supports
  recursive structural expansion and optional inline explanations for
  technical terms, phrases, symbols, and abbreviations. Use only when the
  registered publish_semantic_answer MCP tool or configured HTTP fallback is
  available.
---

# Semantic Answer Tree

## Purpose

Produce one final answer that can be read at selectively chosen levels of
detail.

The answer has two independent forms of semantic zoom:

1. **Structural zoom**
   - A node summarizes a meaningful part of the answer.
   - Expanding it reveals more detailed child nodes.
   - Different branches can be expanded independently.

2. **Lexical zoom**
   - A technical term, phrase, method name, symbol, or abbreviation may be
     clicked to reveal a short contextual explanation.
   - Lexical explanations do not create reasoning branches.

All tree nodes and term explanations are generated in the initial response.
Opening a node or term must not trigger another model request.

## Single presentation surface

Create exactly one logical publication envelope for the intended viewer turn.
"Exactly one" constrains the logical publication, not the number of transport
calls: the same-key recovery calls defined below are allowed, but a second
logical envelope is not.

For this implementation, prefer the registered `publish_semantic_answer` MCP
tool. If that tool is unavailable and the local HTTP fallback is explicitly
configured and running, use `POST /api/publish` with the configured Bearer
token. Choose one transport before the first publication call; do not switch
transports or use both transports for the same logical publication.

After a durable success acknowledgement, the viewer is the sole answer surface.

Do not also emit:

- a prose copy of the answer;
- raw JSON;
- a Markdown or HTML duplicate;
- an abbreviated second answer;
- expansion commands;
- a table of node IDs;
- a glossary repeated outside the viewer.

After durable success, emit only this fixed status message:

```text
Rendered in Semantic Answer Tree.
```

It must not contain answer content.

## Transcript context

When earlier answers from the same viewer session are relevant, call
`read_semantic_history` first and use its compact result. With the Codex hook,
submit no guessed `sourceSessionKey`; the history hook overwrites it with the
current session identity. A manual integration must supply its bound session
identity explicitly. Call
`read_semantic_turn` for at most one selected turn, and only when that turn's
full tree is necessary. Select its turn ID from that same-session compact
result; do not guess or enumerate turn IDs. Do not automatically request a
large history window or read multiple full turns.

## Publication envelope and recovery

Write `requestSummary` as one or two concise sentences describing what the
user asked in this turn. Summarize the request, not the answer. Do not add tags,
categories, or a second validation scheme.

Keep the public `SemanticAnswer` schema unchanged at version 1: transport
metadata must remain outside the document. This does not prohibit repairing
invalid document content after a validation rejection. The service receives
this resolved transport envelope:

```ts
type PublicationEnvelope = {
  requestSummary: string;
  document: SemanticAnswer;
  idempotencyKey: string;
  sourceSessionKey: string;
  sourceTurnKey?: string;
};
```

With the configured Codex hook, submit `requestSummary` and `document`. The
hook completes the envelope by overwriting `sourceSessionKey`,
`sourceTurnKey`, and `idempotencyKey` with values derived from the current
Codex session and turn. Do not invent or guess those fields. On this hook path,
`sourceTurnKey` is always present; it is optional only for manual or other
non-Codex integrations.

For an explicit manual or HTTP fallback, supply `requestSummary`, `document`,
`sourceSessionKey`, and one stable `idempotencyKey` explicitly; supply
`sourceTurnKey` when that integration has a stable turn identity. Reuse the
same idempotency key for every allowed recovery call.

Treat an acknowledgement as durable success only when `ok` is `true`,
`sessionId` and `turnId` are non-empty strings, `sequence` is a positive
integer, and no error is present. Do not require the response object to equal
an exact four-property object. Do not emit the fixed status before receiving a
qualifying acknowledgement.

Across one logical publication, allow at most one repaired call after a
definitive validation rejection and at most one identical same-key recovery
call after an ambiguous acknowledgement. These are independent
per-publication allowances, each usable once. Thus, if its allowance is still
unused, an ambiguously acknowledged repaired call may receive the identical
recovery call. Never change the idempotency key. Do not retry a definitive
non-validation failure.

When the service receives an identical same-key recovery call after committing
the first call, it returns the committed turn's acknowledgement instead of
appending another turn. If the recovery call is also unreachable or ambiguous,
the viewer state cannot be confirmed. Do not claim viewer success; give the
complete answer normally in the conversation. Idempotency protects calls that
reach the service, but permanent loss of reachability makes an absolute
duplicate-free outcome impossible to confirm.

For every other publication failure without a qualifying acknowledgement, do
not claim that the viewer rendered the answer. Emit the complete answer
normally in the conversation instead.

## Output schema

Submit exactly this document shape:

```json
{
  "version": 1,
  "title": "...",
  "root": {
    "content": "...",
    "children": []
  },
  "terms": {
    "term-id": "..."
  }
}
```

The logical types are:

```ts
type SemanticAnswer = {
  version: 1;
  title: string;
  root: SemanticNode;
  terms?: Record<string, string>;
};

type SemanticNode = {
  content: string;
  children?: SemanticNode[];
};
```

`content` and term definitions contain Markdown.

Do not add node IDs, node types, parent links, explicit levels, expansion
states, summaries, details fields, semantic contracts, patches, or transport
metadata.

## Root node

The root content directly answers the user's main question.

It must communicate the overall judgment, recommendation, result, or
explanation without requiring expansion.

The root is not:

* a table of contents;
* a list of topics to be discussed;
* a promise that the real answer appears in child nodes;
* a generic heading such as "Analysis" or "Recommended approach."

A simple answer may consist only of the root node.

## Semantic-tree invariant

Every node's `content` is an accurate, independently understandable
compression of its entire subtree.

Its children add explanatory resolution. They must not replace, contradict,
or silently qualify the parent.

At any expansion state, the currently visible frontier of the tree should form
a coherent answer.

A user who leaves a node collapsed should still understand the conclusion
represented by that node.

### Bad parent

> Reconcile the feeds.

The reader does not know which records are related, how sources are tracked,
or how conflicts are handled.

### Good parent

> Merge the two synthetic catalog feeds only when records share the same stable
> item ID, retain the source of every selected field, and flag conflicting
> values for review. This produces one traceable record per item, but it does
> not resolve conflicts automatically.

Its children may then explain:

* how the item-identity relation is defined;
* which source information is retained for each field;
* how missing and conflicting values are classified;
* which reconciliation counts should be reported.

## Child-node rule

Create child nodes only when the parent contains genuinely separable
explanatory directions that a user may want to inspect independently.

Useful child directions include:

* mechanism;
* rationale;
* evidence;
* derivation;
* comparison;
* implementation;
* failure conditions;
* risks;
* validation;
* examples.

Children should collectively explain, support, refine, or operationalize the
parent.

Sibling nodes should cover distinct content. Do not split one paragraph into
several children merely to create visual structure.

Do not create a child that only restates its parent with more words.

## Adaptive depth

Depth is determined by the answer, not by a fixed template.

Typical behavior:

* simple factual response: root only;
* ordinary explanation: root plus one or two structural depths;
* complex research or engineering analysis: two to four structural depths.

Avoid deeper nesting unless each level creates a real choice about what the
user may skip or inspect.

Do not force every branch to have equal depth.

Do not create empty or decorative branches.

## Decision-relevant information

Any information that could materially change the user's decision must be
visible at the node where that decision or recommendation is stated.

A descendant may explain the caveat in detail, but the parent must reveal that
the caveat exists.

Do not hide important limitations, prerequisites, uncertainty, risks, or
counterevidence in deep descendants.

## Inline term explanations

Use Markdown links with the custom `term:` scheme:

```markdown
[visible phrase](term:term-id)
```

Define the referenced explanation in the top-level `terms` map:

```json
{
  "terms": {
    "term-id": "Contextual Markdown explanation."
  }
}
```

Term IDs must be stable ASCII slugs containing lowercase letters, digits,
hyphens, underscores, or periods.

Every `term:` reference must have a matching definition.

Do not emit unused term definitions.

### What deserves a term explanation

Annotate a phrase when a reader may understand the surrounding claim but may
not know what that local expression means.

Common examples:

* paper-specific method names;
* mathematical symbols;
* abbreviations;
* domain-specific terminology;
* compact phrases introduced for repeated use;
* a familiar term used in an unusually specific sense.

Examples:

```markdown
Apply [identity matching](term:identity-matching) before the
[source-aware merge](term:source-aware-merge).

Send each [value conflict](term:value-conflict) to review instead of choosing
silently.
```

Define those references in the same payload:

```json
{
  "terms": {
    "identity-matching": "The rule used here to treat two input records as the same item when their stable item IDs are equal.",
    "source-aware-merge": "Combining fields while recording which input supplied each selected value.",
    "value-conflict": "A field for which records identified as the same item supply different non-empty values."
  }
}
```

### Term-definition contract

A term definition should explain what the phrase means **in this answer**.

Prefer one to three concise sentences.

A definition may include a small formula or a short example when necessary,
but it should not become a second article.

Definitions must be:

* contextual;
* concrete;
* non-circular;
* understandable without opening another term;
* consistent with every occurrence using that term ID.

Do not recursively annotate terms inside term definitions in schema version 1.

When the same visible phrase has different meanings in different contexts,
use different term IDs.

### What must not be a term explanation

Do not use terms to hide:

* reasoning;
* evidence;
* recommendations;
* decision-changing caveats;
* important failure modes;
* implementation plans;
* substantial comparisons.

If explaining a phrase requires multiple independently useful parts, represent
that explanation as a structural node instead.

Lexical zoom answers:

> What does this phrase mean here?

Structural zoom answers:

> Why is this claim true, how does it work, and what follows from it?

## Markdown use

Node content and term definitions may use:

* paragraphs;
* emphasis;
* lists;
* code spans and code fences;
* tables;
* equations;
* ordinary links;
* file paths and source references.

Do not emit raw HTML.

Use ordinary links for external resources:

```markdown
[paper](https://example.com)
```

Use `term:` links only for local lexical explanations.

## Non-duplication

Do not duplicate prose between:

* the root and its children;
* a parent and a child;
* sibling branches;
* multiple occurrences of the same term definition;
* the viewer payload and the normal Codex final response.

The parent gives the compressed semantic result.

The children begin where the parent stops and add resolution.

A repeated term should reuse the same term ID when its meaning is unchanged.

## Proportional detail

All hidden content is generated up front. Hidden content is therefore not free.

Do not create exhaustive descendants merely because they are initially
collapsed.

Generate the amount of detail appropriate to the user's request.

Prefer fewer meaningful branches over a large, shallow catalogue.

## Construction process

Before publishing:

1. Determine the direct answer.
2. Write it as the root content.
3. Identify the distinct questions a user may want to inspect separately.
4. Create child nodes for those questions.
5. Recursively add detail only where another independently useful reading
   choice exists.
6. Mark locally opaque terms with `term:` links.
7. Define each referenced term once in the `terms` map.
8. Remove duplicated or decorative nodes.
9. Run the semantic consistency checks below.
10. Write the concise `requestSummary`, create one logical publication
    envelope, and submit it through exactly one configured sink.

## Semantic consistency checks

For every non-leaf node:

* Read only the parent.

  * Is its conclusion understandable?
  * Does it expose every decision-changing caveat?

* Read only its children.

  * Do they explain or support the same claim?
  * Do they collectively justify the parent rather than introduce a different
    answer?

* Compress the children mentally.

  * Would the result recover the parent content?

* Expand the parent mentally.

  * Are the children the natural next level of explanation?

Revise the tree if these checks fail.

## Lexical consistency checks

Before publishing:

* Does every `term:` reference resolve?
* Is every definition actually useful?
* Is the definition contextual rather than encyclopedic?
* Is any important argument improperly hidden inside a definition?
* Could the phrase be understood directly by slightly improving the sentence,
  making the annotation unnecessary?
* Are multiple meanings incorrectly sharing one term ID?

Remove annotations that create clutter without improving comprehension.

## Final validation

Verify that:

* the payload matches schema version 1;
* the root directly answers the user;
* every collapsed node remains meaningful;
* every child adds information rather than repetition;
* the tree depth is justified;
* all decision-relevant caveats appear early enough;
* every term reference resolves;
* no definition contains a hidden argument branch;
* all content was generated in this response;
* history use was compact and no more than one full prior turn was opened;
* one logical envelope and one `idempotencyKey` represent this publication;
* a qualifying durable acknowledgement arrived before the fixed status;
* no duplicate answer is emitted after successful publication;
* ordinary conversation output is used only when publication cannot be
  confirmed.
