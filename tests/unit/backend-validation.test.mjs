import assert from "node:assert/strict";
import test from "node:test";

import {
  SEMANTIC_ANSWER_LIMITS,
  assertPublicationEnvelope,
  assertSemanticAnswer,
  extractExpansionReferences,
  sanitizeValidationIssues,
  SemanticAnswerValidationError,
  validatePublicationEnvelope,
  validateSemanticAnswer,
} from "../../server/validation.mjs";

function fixture(overrides = {}) {
  return {
    version: 1,
    title: "Refreshing K",
    body:
      "Refresh [K](zoom:k-holonomy), then read the [paper](https://example.com). " +
      "The answer remains useful while closed.",
    expansions: {
      "k-holonomy": {
        kind: "definition",
        content: "The discrete transition data used in this answer.",
      },
    },
    ...overrides,
  };
}

function issueCodes(result) {
  assert.equal(result.ok, false);
  return result.issues.map((issue) => issue.code);
}

test("accepts the exact linear SemanticAnswer v1 shape and repeated resolved anchors", () => {
  const document = fixture({
    body: "[K](zoom:k-holonomy) changes; reuse [K](zoom:k-holonomy) consistently.",
  });
  assert.deepEqual(validateSemanticAnswer(document), { ok: true, value: document });
  assert.equal(assertSemanticAnswer(document), document);
});

test("accepts definition and detail expansions with only their strict public fields", () => {
  const document = fixture({
    body: "A [term](zoom:term) can also open [substantial detail](zoom:detail).",
    expansions: {
      term: { kind: "definition", content: "A contextual definition." },
      detail: { kind: "detail", title: "Why this matters", content: "Supporting Markdown." },
    },
  });
  assert.equal(validateSemanticAnswer(document).ok, true);

  document.transport = "http";
  document.expansions.detail.mode = "rail";
  const result = validateSemanticAnswer(document);
  assert.deepEqual(
    result.issues.filter((issue) => issue.code === "unknown_field").map((issue) => issue.path),
    ["$.transport", '$.expansions["detail"].mode'],
  );
});

test("rejects the old tree shape without a compatibility path", () => {
  const oldTree = {
    version: 1,
    title: "Old tree",
    root: { content: "Old root", children: [{ content: "Old child" }] },
    terms: { old: "Old definition" },
  };
  const result = validateSemanticAnswer(oldTree);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "required" && issue.path === "$.body"));
  assert.deepEqual(
    result.issues.filter((issue) => issue.code === "unknown_field").map((issue) => issue.path),
    ["$.root", "$.terms"],
  );
});

test("requires version 1, string title, non-empty body, and valid expansion values", () => {
  const result = validateSemanticAnswer({
    version: "1",
    title: 7,
    body: "  ",
    expansions: {
      one: { kind: "aside", title: 3, content: " " },
      two: "not an object",
    },
  });
  const codes = issueCodes(result);
  assert.ok(codes.includes("invalid_version"));
  assert.ok(codes.includes("invalid_type"));
  assert.ok(codes.includes("empty_content"));
  assert.ok(codes.includes("invalid_expansion_kind"));

  const emptyTitle = validateSemanticAnswer({ version: 1, title: " \t ", body: "Complete." });
  assert.ok(
    emptyTitle.issues.some(
      (issue) => issue.code === "empty_content" && issue.path === "$.title",
    ),
  );
});

test("enforces body, document, expansion count, ID, title, and content limits", () => {
  const small = {
    ...SEMANTIC_ANSWER_LIMITS,
    maxBodyBytes: 8,
    maxDocumentBytes: 120,
    maxExpansions: 1,
    maxExpansionIdLength: 5,
    maxExpansionTitleBytes: 4,
    maxExpansionContentBytes: 4,
  };
  const document = {
    version: 1,
    title: "x",
    body: "content too long [one](zoom:toolong) [two](zoom:second)",
    expansions: {
      toolong: { kind: "detail", title: "title", content: "content" },
      second: { kind: "definition", content: "also long" },
    },
  };
  const result = validateSemanticAnswer(document, small);
  assert.ok(issueCodes(result).includes("limit_exceeded"));
  assert.ok(result.issues.some((issue) => issue.path === "$.body"));
  assert.ok(result.issues.some((issue) => issue.path === "$.expansions"));
  assert.ok(result.issues.some((issue) => issue.path.includes("toolong")));

  const totalOnly = validateSemanticAnswer(
    { version: 1, title: "x", body: "short" },
    { ...SEMANTIC_ANSWER_LIMITS, maxDocumentBytes: 10 },
  );
  assert.ok(totalOnly.issues.some((issue) => issue.path === "$" && issue.code === "limit_exceeded"));
});

test("rejects malformed, unresolved, and unused expansions", () => {
  const result = validateSemanticAnswer({
    version: 1,
    title: "Anchors",
    body: "Open [one](zoom:Missing) and [two](zoom:not-defined).",
    expansions: {
      Missing: { kind: "definition", content: "Invalid uppercase ID." },
      unused: { kind: "detail", content: "No anchor points here." },
    },
  });
  const codes = issueCodes(result);
  assert.ok(codes.includes("invalid_expansion_id"));
  assert.ok(codes.includes("invalid_expansion_reference"));
  assert.ok(codes.includes("unresolved_expansion_reference"));
  assert.ok(codes.includes("unused_expansion"));
});

test("ordinary links and zoom-looking examples in code do not create anchors", () => {
  const markdown = [
    "See [paper](https://example.com).",
    "A legacy-looking [term link](term:not-an-expansion) is only an ordinary link.",
    "![image anchor lookalike](zoom:nope)",
    "`[inline](zoom:nope)`",
    "``multiline code span",
    "[also hidden](zoom:nope)",
    "``",
    "```md",
    "[fenced](zoom:nope)",
    "```",
    "Use [real](zoom:real-detail).",
  ].join("\n");
  assert.deepEqual(extractExpansionReferences(markdown), ["real-detail"]);
  assert.equal(
    validateSemanticAnswer({
      version: 1,
      title: "Links",
      body: markdown,
      expansions: { "real-detail": { kind: "detail", content: "Supporting detail." } },
    }).ok,
    true,
  );
});

test("indented code and escaped opening brackets do not create zoom anchors", () => {
  const markdown = [
    "    [four-space code](zoom:nope)",
    "\t[tab code](zoom:nope)",
    "  \t[mixed-indent code](zoom:nope)",
    "\\[escaped link](zoom:nope)",
    "\\\\[even backslashes](zoom:even)",
    "Use [real](zoom:real-detail).",
  ].join("\n");

  assert.deepEqual(extractExpansionReferences(markdown), ["even", "real-detail"]);
  assert.equal(
    validateSemanticAnswer({
      version: 1,
      title: "Markdown parity",
      body: markdown,
      expansions: {
        even: { kind: "definition", content: "The bracket is not escaped." },
        "real-detail": { kind: "detail", content: "Supporting detail." },
      },
    }).ok,
    true,
  );
});

test("recognizes only links that ReactMarkdown renders outside skipped HTML", () => {
  const markdown = [
    "A paragraph",
    "    [lazy continuation](zoom:continuation)",
    "",
    ">     [blockquote code](zoom:nope)",
    "",
    "<!-- [comment link](zoom:nope) -->",
    "",
    "<div>",
    "[HTML block link](zoom:nope)",
    "</div>",
    "",
    "[<span></span>](zoom:no-visible-label)",
    "[** **](zoom:no-visible-text)",
    "",
    "\\[escaped link](zoom:nope)",
    "![image](zoom:nope)",
    "`[inline code](zoom:nope)`",
    "```md",
    "[fenced code](zoom:nope)",
    "```",
    "[normal link](zoom:normal)",
    "[encoded link](zoom:encoded%2Did)",
  ].join("\n");

  assert.deepEqual(extractExpansionReferences(markdown), [
    "continuation",
    "no-visible-label",
    "no-visible-text",
    "normal",
    "encoded-id",
  ]);
  const result = validateSemanticAnswer({
      version: 1,
      title: "Rendered Markdown semantics",
      body: markdown,
      expansions: {
        continuation: { kind: "detail", content: "A lazy paragraph continuation." },
        normal: { kind: "definition", content: "A normal rendered link." },
        "encoded-id": { kind: "definition", content: "A decoded expansion ID." },
        "no-visible-label": { kind: "definition", content: "This anchor has no visible label." },
        "no-visible-text": { kind: "definition", content: "This anchor has no visible text." },
      },
  });
  assert.equal(result.ok, false);
  assert.ok(issueCodes(result).includes("empty_expansion_label"));

  assert.equal(
    validateSemanticAnswer({
      version: 1,
      title: "Rendered Markdown semantics",
      body: markdown
        .replace("[<span></span>](zoom:no-visible-label)\n", "")
        .replace("[** **](zoom:no-visible-text)\n", ""),
      expansions: {
        continuation: { kind: "detail", content: "A lazy paragraph continuation." },
        normal: { kind: "definition", content: "A normal rendered link." },
        "encoded-id": { kind: "definition", content: "A decoded expansion ID." },
      },
    }).ok,
    true,
  );
});

test("rejects recursive live zoom anchors in expansion content but ignores code examples", () => {
  const invalid = validateSemanticAnswer({
    version: 1,
    title: "No recursion",
    body: "Open [detail](zoom:detail).",
    expansions: {
      detail: { kind: "detail", content: "Do not [recurse](zoom:detail)." },
    },
  });
  assert.ok(issueCodes(invalid).includes("nested_expansion_reference"));

  const valid = fixture({
    body: "Open [detail](zoom:detail).",
    expansions: {
      detail: {
        kind: "detail",
        content: "`[inline](zoom:nope)`\n\n```md\n[fenced](zoom:nope)\n```",
      },
    },
  });
  assert.equal(validateSemanticAnswer(valid).ok, true);
});

test("accepts the strict publication envelope without changing the document", () => {
  const envelope = {
    sessionId: "codex:session-1",
    requestSummary: "Explain the refresh rule",
    document: fixture(),
    idempotencyKey: "once:session-1:turn-1",
  };
  assert.deepEqual(validatePublicationEnvelope(envelope), { ok: true, value: envelope });
  assert.equal(assertPublicationEnvelope(envelope), envelope);
  assert.deepEqual(Object.keys(envelope.document).sort(), ["body", "expansions", "title", "version"]);
});

test("rejects missing identity, empty summary, unknown envelope fields, and nested answer errors", () => {
  const result = validatePublicationEnvelope({
    requestSummary: " ",
    document: fixture({ transport: "not-schema" }),
    idempotencyKey: "once",
    latest: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === "$.sessionId"));
  assert.ok(result.issues.some((issue) => issue.path === "$.requestSummary"));
  assert.ok(result.issues.some((issue) => issue.path === "$.latest"));
  assert.ok(result.issues.some((issue) => issue.path === "$.document.transport"));
});

test("safe validation issues redact arbitrary unknown field and expansion IDs", () => {
  const keyCanary = "PRIVATE_UNKNOWN_KEY_CANARY";
  const document = fixture();
  document.expansions["k-holonomy"][keyCanary] = true;
  document.expansions[keyCanary] = { kind: "detail", content: "private" };
  const result = validatePublicationEnvelope({
    sessionId: "session",
    requestSummary: "summary",
    document,
    idempotencyKey: "idempotency",
    [keyCanary]: true,
  });
  assert.equal(result.ok, false);
  const sanitized = sanitizeValidationIssues(result.issues);
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, new RegExp(keyCanary));
  assert.ok(sanitized.every((issue) => !issue.message.includes(keyCanary)));
  assert.throws(() => assertSemanticAnswer(document), SemanticAnswerValidationError);
});
