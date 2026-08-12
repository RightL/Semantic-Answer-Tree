import { Buffer } from "node:buffer";

export const SEMANTIC_ANSWER_LIMITS = Object.freeze({
  maxDepth: 12,
  maxNodes: 1_000,
  maxTitleBytes: 4 * 1_024,
  maxContentBytes: 256 * 1_024,
  maxDocumentBytes: 2 * 1_024 * 1_024,
  maxTerms: 500,
  maxTermIdLength: 128,
  maxTermDefinitionBytes: 64 * 1_024,
});

export const PUBLICATION_ENVELOPE_LIMITS = Object.freeze({
  maxSourceSessionKeyBytes: 1_024,
  maxSourceTurnKeyBytes: 1_024,
  maxRequestSummaryBytes: 16 * 1_024,
  maxIdempotencyKeyBytes: 512,
  maxEnvelopeOverheadBytes: 64 * 1_024,
});

const TOP_LEVEL_FIELDS = new Set(["version", "title", "root", "terms"]);
const NODE_FIELDS = new Set(["content", "children"]);
const TERM_ID_PATTERN = /^[a-z0-9._-]+$/;
const MAX_REPORTED_ISSUES = 50;
const PUBLICATION_FIELDS = new Set([
  "sourceSessionKey",
  "sourceTurnKey",
  "requestSummary",
  "document",
  "idempotencyKey",
]);

/**
 * A validation error that is safe to return through HTTP or MCP. It contains
 * paths and concise diagnostics, never the rejected answer body.
 */
export class SemanticAnswerValidationError extends Error {
  constructor(issues) {
    super("The semantic answer is invalid.");
    this.name = "SemanticAnswerValidationError";
    this.code = "invalid_semantic_answer";
    this.issues = issues;
  }
}

export class PublicationEnvelopeValidationError extends Error {
  constructor(issues) {
    super("The publication envelope is invalid.");
    this.name = "PublicationEnvelopeValidationError";
    this.code = "invalid_publish_envelope";
    this.issues = issues;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function owns(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function findClosingFence(lines, startIndex, marker, width) {
  const closingPattern = new RegExp(`^ {0,3}${marker}{${width},}\\s*$`);
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (closingPattern.test(lines[index])) {
      return index;
    }
  }
  return lines.length - 1;
}

/**
 * Remove code spans and fenced code blocks before recognizing Markdown links.
 * A term-looking string in example code is not a lexical reference.
 */
function markdownOutsideCode(markdown) {
  const lines = markdown.split("\n");
  const visibleLines = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1][0];
      lineIndex = findClosingFence(lines, lineIndex, marker, fence[1].length);
      visibleLines.push("");
      continue;
    }

    let visible = "";
    for (let index = 0; index < line.length; ) {
      if (line[index] !== "`") {
        visible += line[index];
        index += 1;
        continue;
      }

      let width = 1;
      while (line[index + width] === "`") {
        width += 1;
      }
      const delimiter = "`".repeat(width);
      const closeIndex = line.indexOf(delimiter, index + width);
      if (closeIndex === -1) {
        visible += line.slice(index);
        break;
      }
      visible += " ".repeat(closeIndex + width - index);
      index = closeIndex + width;
    }
    visibleLines.push(visible);
  }

  return visibleLines.join("\n");
}

/**
 * Return the destinations of Markdown links using the custom term: scheme.
 * The public format deliberately supports only the simple link form described
 * by the SemanticAnswer v1 contract.
 */
export function extractTermReferences(markdown) {
  const visibleMarkdown = markdownOutsideCode(markdown);
  const references = [];
  const linkPattern = /\]\(\s*<?term:([^\s)>]*)>?\s*(?:["'][^"']*["']\s*)?\)/g;
  let match;

  while ((match = linkPattern.exec(visibleMarkdown)) !== null) {
    references.push(match[1]);
  }

  return references;
}

function createIssueCollector() {
  const issues = [];
  let truncated = false;

  return {
    add(issue) {
      if (issues.length < MAX_REPORTED_ISSUES) {
        issues.push(issue);
      } else if (!truncated) {
        truncated = true;
        issues.push({
          code: "too_many_errors",
          path: "$",
          message: `More than ${MAX_REPORTED_ISSUES} validation errors were found.`,
          limit: MAX_REPORTED_ISSUES,
        });
      }
    },
    get issues() {
      return issues;
    },
  };
}

function reportUnknownFields(value, allowed, path, collector) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      collector.add({
        code: "unknown_field",
        path: `${path}.${key}`,
        safePath: `${path}["<field>"]`,
        message: `Unknown field '${key}'.`,
      });
    }
  }
}

function reportStringLimit(value, limit, path, collector, label) {
  const actual = byteLength(value);
  if (actual > limit) {
    collector.add({
      code: "limit_exceeded",
      path,
      message: `${label} exceeds the ${limit}-byte limit.`,
      limit,
      actual,
    });
  }
}

/**
 * Validate a SemanticAnswer v1 value without mutating it.
 *
 * @returns {{ok: true, value: object}|{ok: false, issues: object[]}}
 */
export function validateSemanticAnswer(value, limits = SEMANTIC_ANSWER_LIMITS) {
  const collector = createIssueCollector();
  const termReferences = [];
  const ancestorNodes = new WeakSet();
  let nodeCount = 0;
  let stoppedForNodeLimit = false;

  if (!isObject(value)) {
    collector.add({
      code: "invalid_type",
      path: "$",
      message: "Semantic answer must be an object.",
      expected: "object",
    });
    return { ok: false, issues: collector.issues };
  }

  reportUnknownFields(value, TOP_LEVEL_FIELDS, "$", collector);

  if (!owns(value, "version")) {
    collector.add({ code: "required", path: "$.version", message: "version is required." });
  } else if (value.version !== 1) {
    collector.add({
      code: "invalid_version",
      path: "$.version",
      message: "version must be exactly 1.",
      expected: 1,
    });
  }

  if (!owns(value, "title")) {
    collector.add({ code: "required", path: "$.title", message: "title is required." });
  } else if (typeof value.title !== "string") {
    collector.add({
      code: "invalid_type",
      path: "$.title",
      message: "title must be a string.",
      expected: "string",
    });
  } else {
    reportStringLimit(value.title, limits.maxTitleBytes, "$.title", collector, "title");
  }

  function visitNode(node, path, depth) {
    if (depth > limits.maxDepth) {
      collector.add({
        code: "limit_exceeded",
        path,
        message: `Tree depth exceeds the maximum depth of ${limits.maxDepth}.`,
        limit: limits.maxDepth,
        actual: depth,
      });
      return;
    }

    if (!isObject(node)) {
      collector.add({
        code: "invalid_type",
        path,
        message: "Node must be an object.",
        expected: "object",
      });
      return;
    }

    if (ancestorNodes.has(node)) {
      collector.add({
        code: "circular_reference",
        path,
        message: "Nodes must not contain circular references.",
      });
      return;
    }

    nodeCount += 1;
    if (nodeCount > limits.maxNodes) {
      if (!stoppedForNodeLimit) {
        stoppedForNodeLimit = true;
        collector.add({
          code: "limit_exceeded",
          path,
          message: `Tree contains more than ${limits.maxNodes} nodes.`,
          limit: limits.maxNodes,
          actual: nodeCount,
        });
      }
      return;
    }

    ancestorNodes.add(node);
    reportUnknownFields(node, NODE_FIELDS, path, collector);

    if (!owns(node, "content")) {
      collector.add({ code: "required", path: `${path}.content`, message: "content is required." });
    } else if (typeof node.content !== "string") {
      collector.add({
        code: "invalid_type",
        path: `${path}.content`,
        message: "content must be a string.",
        expected: "string",
      });
    } else if (node.content.trim().length === 0) {
      collector.add({
        code: "empty_content",
        path: `${path}.content`,
        message: "content must not be empty.",
      });
    } else {
      reportStringLimit(
        node.content,
        limits.maxContentBytes,
        `${path}.content`,
        collector,
        "Node content",
      );
      for (const termId of extractTermReferences(node.content)) {
        termReferences.push({ termId, path: `${path}.content` });
      }
    }

    if (owns(node, "children")) {
      if (!Array.isArray(node.children)) {
        collector.add({
          code: "invalid_type",
          path: `${path}.children`,
          message: "children must be an array when present.",
          expected: "array",
        });
      } else {
        for (let index = 0; index < node.children.length; index += 1) {
          if (stoppedForNodeLimit) {
            break;
          }
          visitNode(node.children[index], `${path}.children[${index}]`, depth + 1);
        }
      }
    }

    ancestorNodes.delete(node);
  }

  if (!owns(value, "root")) {
    collector.add({ code: "required", path: "$.root", message: "root is required." });
  } else {
    visitNode(value.root, "$.root", 0);
  }

  const termIds = new Set();
  if (owns(value, "terms")) {
    if (!isObject(value.terms)) {
      collector.add({
        code: "invalid_type",
        path: "$.terms",
        message: "terms must be an object when present.",
        expected: "object",
      });
    } else {
      const entries = Object.entries(value.terms);
      if (entries.length > limits.maxTerms) {
        collector.add({
          code: "limit_exceeded",
          path: "$.terms",
          message: `terms contains more than ${limits.maxTerms} definitions.`,
          limit: limits.maxTerms,
          actual: entries.length,
        });
      }

      for (const [termId, definition] of entries.slice(0, limits.maxTerms + 1)) {
        const termPath = `$.terms[${JSON.stringify(termId)}]`;
        if (!TERM_ID_PATTERN.test(termId)) {
          collector.add({
            code: "invalid_term_id",
            path: termPath,
            message: "Term IDs may contain only lowercase ASCII letters, digits, '.', '_', and '-'.",
          });
        } else if (termId.length > limits.maxTermIdLength) {
          collector.add({
            code: "limit_exceeded",
            path: termPath,
            message: `Term ID exceeds the ${limits.maxTermIdLength}-character limit.`,
            limit: limits.maxTermIdLength,
            actual: termId.length,
          });
        } else {
          termIds.add(termId);
        }

        if (typeof definition !== "string") {
          collector.add({
            code: "invalid_type",
            path: termPath,
            message: "Term definitions must be strings.",
            expected: "string",
          });
        } else {
          reportStringLimit(
            definition,
            limits.maxTermDefinitionBytes,
            termPath,
            collector,
            "Term definition",
          );
        }
      }
    }
  }

  for (const { termId, path } of termReferences) {
    if (!TERM_ID_PATTERN.test(termId) || termId.length > limits.maxTermIdLength) {
      collector.add({
        code: "invalid_term_reference",
        path,
        message: `Invalid term reference '${termId}'.`,
        reference: termId,
      });
    } else if (!termIds.has(termId)) {
      collector.add({
        code: "unresolved_term_reference",
        path,
        message: `No definition exists for term '${termId}'.`,
        reference: termId,
      });
    }
  }

  if (collector.issues.length === 0) {
    let encoded;
    try {
      encoded = JSON.stringify(value);
    } catch {
      collector.add({
        code: "not_serializable",
        path: "$",
        message: "Semantic answer must be JSON-serializable.",
      });
    }

    if (encoded !== undefined) {
      const actual = byteLength(encoded);
      if (actual > limits.maxDocumentBytes) {
        collector.add({
          code: "limit_exceeded",
          path: "$",
          message: `Document exceeds the ${limits.maxDocumentBytes}-byte limit.`,
          limit: limits.maxDocumentBytes,
          actual,
        });
      }
    }
  }

  if (collector.issues.length > 0) {
    return { ok: false, issues: collector.issues };
  }

  return { ok: true, value };
}

export function assertSemanticAnswer(value, limits = SEMANTIC_ANSWER_LIMITS) {
  const result = validateSemanticAnswer(value, limits);
  if (!result.ok) {
    throw new SemanticAnswerValidationError(result.issues);
  }
  return result.value;
}

function validateRequiredEnvelopeString(value, field, byteLimit, collector, optional = false) {
  const path = `$.${field}`;
  if (!owns(value, field)) {
    if (!optional) {
      collector.add({ code: "required", path, message: `${field} is required.` });
    }
    return;
  }
  if (typeof value[field] !== "string") {
    collector.add({ code: "invalid_type", path, message: `${field} must be a string.` });
    return;
  }
  if (value[field].trim().length === 0) {
    collector.add({ code: "empty_value", path, message: `${field} must not be empty.` });
    return;
  }
  reportStringLimit(value[field], byteLimit, path, collector, field);
}

/** Validate the append-only publication envelope without changing SemanticAnswer v1. */
export function validatePublicationEnvelope(
  value,
  limits = PUBLICATION_ENVELOPE_LIMITS,
  answerLimits = SEMANTIC_ANSWER_LIMITS,
) {
  const collector = createIssueCollector();
  if (!isObject(value)) {
    collector.add({
      code: "invalid_type",
      path: "$",
      message: "Publication must be an object.",
      expected: "object",
    });
    return { ok: false, issues: collector.issues };
  }

  reportUnknownFields(value, PUBLICATION_FIELDS, "$", collector);
  validateRequiredEnvelopeString(
    value,
    "sourceSessionKey",
    limits.maxSourceSessionKeyBytes,
    collector,
  );
  validateRequiredEnvelopeString(
    value,
    "sourceTurnKey",
    limits.maxSourceTurnKeyBytes,
    collector,
    true,
  );
  validateRequiredEnvelopeString(
    value,
    "requestSummary",
    limits.maxRequestSummaryBytes,
    collector,
  );
  validateRequiredEnvelopeString(
    value,
    "idempotencyKey",
    limits.maxIdempotencyKeyBytes,
    collector,
  );

  if (!owns(value, "document")) {
    collector.add({ code: "required", path: "$.document", message: "document is required." });
  } else {
    const answerResult = validateSemanticAnswer(value.document, answerLimits);
    if (!answerResult.ok) {
      for (const issue of answerResult.issues) {
        collector.add({
          ...issue,
          path: issue.path === "$" ? "$.document" : `$.document${issue.path.slice(1)}`,
        });
      }
    }
  }

  if (collector.issues.length > 0) {
    return { ok: false, issues: collector.issues };
  }

  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    collector.add({ code: "not_serializable", path: "$", message: "Publication must be JSON-serializable." });
  }
  if (encoded !== undefined) {
    const maximum = answerLimits.maxDocumentBytes + limits.maxEnvelopeOverheadBytes;
    const actual = byteLength(encoded);
    if (actual > maximum) {
      collector.add({
        code: "limit_exceeded",
        path: "$",
        message: `Publication exceeds the ${maximum}-byte transport limit.`,
        limit: maximum,
        actual,
      });
    }
  }

  if (collector.issues.length > 0) {
    return { ok: false, issues: collector.issues };
  }
  return { ok: true, value };
}

export function assertPublicationEnvelope(value, limits, answerLimits) {
  const result = validatePublicationEnvelope(value, limits, answerLimits);
  if (!result.ok) {
    throw new PublicationEnvelopeValidationError(result.issues);
  }
  return result.value;
}

const SAFE_ISSUE_MESSAGES = Object.freeze({
  circular_reference: "A circular reference is not allowed.",
  empty_content: "Content must not be empty.",
  empty_value: "The value must not be empty.",
  invalid_term_id: "A term ID is invalid.",
  invalid_term_reference: "A term reference is invalid.",
  invalid_type: "The value has the wrong type.",
  invalid_version: "Only SemanticAnswer version 1 is accepted.",
  limit_exceeded: "A configured size or count limit was exceeded.",
  not_serializable: "The value is not JSON-serializable.",
  required: "A required value is missing.",
  too_many_errors: "Too many validation issues were found.",
  unknown_field: "An unknown field is present.",
  unresolved_term_reference: "A term reference has no matching definition.",
});

/** Strip rejected document values while retaining repairable codes and structural paths. */
export function sanitizeValidationIssues(issues) {
  return issues.map((issue) => ({
    code: issue.code,
    path: String(issue.safePath ?? issue.path).replace(/\["[^"]*"\]/g, '["<key>"]'),
    message: SAFE_ISSUE_MESSAGES[issue.code] ?? "The value is invalid.",
    ...(issue.expected !== undefined ? { expected: issue.expected } : {}),
    ...(issue.limit !== undefined ? { limit: issue.limit } : {}),
    ...(issue.actual !== undefined ? { actual: issue.actual } : {}),
  }));
}
