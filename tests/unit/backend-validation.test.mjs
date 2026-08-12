import assert from "node:assert/strict";
import test from "node:test";

import {
  SEMANTIC_ANSWER_LIMITS,
  assertPublicationEnvelope,
  assertSemanticAnswer,
  extractTermReferences,
  sanitizeValidationIssues,
  SemanticAnswerValidationError,
  validateSemanticAnswer,
  validatePublicationEnvelope,
} from "../../server/validation.mjs";

function fixture(overrides = {}) {
  return {
    version: 1,
    title: "Refreshing K",
    root: {
      content: "Refresh [K](term:k-holonomy), then read the [paper](https://example.com).",
      children: [{ content: "The old state is a warm start, not a valid solution." }],
    },
    terms: {
      "k-holonomy": "The discrete transition data used in this answer.",
    },
    ...overrides,
  };
}

function issueCodes(result) {
  assert.equal(result.ok, false);
  return result.issues.map((issue) => issue.code);
}

function chain(depth) {
  const root = { content: "depth 0" };
  let node = root;
  for (let index = 1; index <= depth; index += 1) {
    node.children = [{ content: `depth ${index}` }];
    [node] = node.children;
  }
  return fixture({ root });
}

test("accepts the exact SemanticAnswer v1 shape and repeated resolved terms", () => {
  const document = fixture({
    root: {
      content: "[K](term:k-holonomy) changes; reuse [K](term:k-holonomy) consistently.",
    },
  });

  assert.deepEqual(validateSemanticAnswer(document), { ok: true, value: document });
  assert.equal(assertSemanticAnswer(document), document);
});

test("rejects unknown fields at the document and recursive node levels", () => {
  const document = fixture({ transport: "http" });
  document.root.id = "not-public-schema";

  const result = validateSemanticAnswer(document);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.issues.filter((issue) => issue.code === "unknown_field").map((issue) => issue.path),
    ["$.transport", "$.root.id"],
  );
});

test("requires version 1, string title, and non-empty node content", () => {
  const result = validateSemanticAnswer({
    version: "1",
    title: 7,
    root: { content: "  ", children: "no" },
  });

  assert.deepEqual(issueCodes(result), [
    "invalid_version",
    "invalid_type",
    "empty_content",
    "invalid_type",
  ]);
});

test("accepts the maximum configured depth and rejects one level beyond it", () => {
  assert.equal(validateSemanticAnswer(chain(SEMANTIC_ANSWER_LIMITS.maxDepth)).ok, true);

  const result = validateSemanticAnswer(chain(SEMANTIC_ANSWER_LIMITS.maxDepth + 1));
  assert.ok(issueCodes(result).includes("limit_exceeded"));
  assert.match(result.issues[0].message, /depth/i);
});

test("enforces node, per-content, total-document, and term limits", () => {
  const small = {
    ...SEMANTIC_ANSWER_LIMITS,
    maxNodes: 2,
    maxContentBytes: 8,
    maxDocumentBytes: 120,
    maxTerms: 1,
    maxTermIdLength: 5,
    maxTermDefinitionBytes: 4,
  };
  const document = {
    version: 1,
    title: "x",
    root: {
      content: "content too long",
      children: [{ content: "one" }, { content: "two" }],
    },
    terms: { toolong: "definition", second: "also long" },
  };

  const result = validateSemanticAnswer(document, small);
  const codes = issueCodes(result);
  assert.ok(codes.includes("limit_exceeded"));
  assert.ok(result.issues.some((issue) => issue.path === "$.root.content"));
  assert.ok(result.issues.some((issue) => issue.path === "$.terms"));
  assert.ok(result.issues.some((issue) => issue.path.includes("toolong")));

  const totalOnly = validateSemanticAnswer(
    { version: 1, title: "x", root: { content: "short" } },
    { ...SEMANTIC_ANSWER_LIMITS, maxDocumentBytes: 10 },
  );
  assert.ok(totalOnly.issues.some((issue) => issue.path === "$" && issue.code === "limit_exceeded"));
});

test("rejects malformed term IDs and unresolved term references", () => {
  const result = validateSemanticAnswer({
    version: 1,
    title: "Terms",
    root: { content: "Open [one](term:Missing) and [two](term:not-defined)." },
    terms: { Missing: "Invalid uppercase ID." },
  });

  const codes = issueCodes(result);
  assert.ok(codes.includes("invalid_term_id"));
  assert.ok(codes.includes("invalid_term_reference"));
  assert.ok(codes.includes("unresolved_term_reference"));
});

test("ordinary links and term-looking examples in code are not term references", () => {
  const markdown = [
    "See [paper](https://example.com).",
    "`[inline](term:nope)`",
    "```md",
    "[fenced](term:nope)",
    "```",
    "Use [real](term:real-term).",
  ].join("\n");

  assert.deepEqual(extractTermReferences(markdown), ["real-term"]);
  assert.equal(
    validateSemanticAnswer({
      version: 1,
      title: "Links",
      root: { content: markdown },
      terms: { "real-term": "A contextual definition." },
    }).ok,
    true,
  );
});

test("reports a circular recursive value instead of recursing indefinitely", () => {
  const root = { content: "root" };
  root.children = [root];
  const result = validateSemanticAnswer({ version: 1, title: "cycle", root });

  assert.ok(issueCodes(result).includes("circular_reference"));
  assert.throws(
    () => assertSemanticAnswer({ version: 1, title: "cycle", root }),
    SemanticAnswerValidationError,
  );
});

test("accepts the strict transcript publication envelope without changing SemanticAnswer v1", () => {
  const envelope = {
    sourceSessionKey: "codex:session-1",
    sourceTurnKey: "turn-1",
    requestSummary: "Explain the refresh rule",
    document: fixture(),
    idempotencyKey: "once:session-1:turn-1",
  };

  assert.deepEqual(validatePublicationEnvelope(envelope), { ok: true, value: envelope });
  assert.equal(assertPublicationEnvelope(envelope), envelope);
  assert.deepEqual(Object.keys(envelope.document).sort(), ["root", "terms", "title", "version"]);
});

test("rejects missing identity, empty summary, unknown envelope fields, and nested answer errors", () => {
  const result = validatePublicationEnvelope({
    requestSummary: " ",
    document: fixture({ transport: "not-schema-v1" }),
    idempotencyKey: "once",
    latest: true,
  });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === "$.sourceSessionKey"));
  assert.ok(result.issues.some((issue) => issue.path === "$.requestSummary"));
  assert.ok(result.issues.some((issue) => issue.path === "$.latest"));
  assert.ok(result.issues.some((issue) => issue.path === "$.document.transport"));
});

test("safe validation issues redact arbitrary unknown field names", () => {
  const keyCanary = "PRIVATE_UNKNOWN_KEY_CANARY";
  const document = fixture();
  document.root[keyCanary] = true;
  const result = validatePublicationEnvelope({
    sourceSessionKey: "session",
    requestSummary: "summary",
    document,
    idempotencyKey: "idempotency",
    [keyCanary]: true,
  });
  assert.equal(result.ok, false);

  const serialized = JSON.stringify(sanitizeValidationIssues(result.issues));
  assert.doesNotMatch(serialized, new RegExp(keyCanary));
  assert.ok(sanitizeValidationIssues(result.issues).every((issue) => !issue.message.includes(keyCanary)));
});
