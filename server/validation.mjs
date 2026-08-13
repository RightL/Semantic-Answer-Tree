import { Buffer } from "node:buffer";

import { extractZoomReferences } from "../shared/zoom-links.mjs";

export const SEMANTIC_ANSWER_LIMITS = Object.freeze({
  maxTitleBytes: 4 * 1_024,
  maxBodyBytes: 1 * 1_024 * 1_024,
  maxDocumentBytes: 2 * 1_024 * 1_024,
  maxExpansions: 500,
  maxExpansionIdLength: 128,
  maxExpansionTitleBytes: 4 * 1_024,
  maxExpansionContentBytes: 256 * 1_024,
});

export const PUBLICATION_ENVELOPE_LIMITS = Object.freeze({
  maxSessionIdBytes: 128,
  maxRequestSummaryBytes: 16 * 1_024,
  maxIdempotencyKeyBytes: 512,
  maxEnvelopeOverheadBytes: 64 * 1_024,
});

const TOP_LEVEL_FIELDS = new Set(["version", "title", "body", "expansions"]);
const EXPANSION_FIELDS = new Set(["kind", "title", "content"]);
const EXPANSION_KINDS = new Set(["definition", "detail"]);
const EXPANSION_ID_PATTERN = /^[a-z0-9._-]+$/;
const MAX_REPORTED_ISSUES = 50;
const PUBLICATION_FIELDS = new Set([
  "sessionId",
  "requestSummary",
  "document",
  "idempotencyKey",
]);

/** A validation error safe to return through HTTP or MCP. */
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

/** Return zoom destinations from links that the reader renders. */
export function extractExpansionReferences(markdown) {
  return extractZoomReferences(markdown).map(({ id }) => id);
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

function reportRequiredString(value, field, path, collector, options = {}) {
  const fieldPath = `${path}.${field}`;
  if (!owns(value, field)) {
    collector.add({ code: "required", path: fieldPath, message: `${field} is required.` });
    return null;
  }
  if (typeof value[field] !== "string") {
    collector.add({
      code: "invalid_type",
      path: fieldPath,
      message: `${field} must be a string.`,
      expected: "string",
    });
    return null;
  }
  if (options.nonEmpty && value[field].trim().length === 0) {
    collector.add({ code: "empty_content", path: fieldPath, message: `${field} must not be empty.` });
  }
  reportStringLimit(value[field], options.maxBytes, fieldPath, collector, field);
  return value[field];
}

/**
 * Validate a SemanticAnswer v1 value without mutating it.
 *
 * @returns {{ok: true, value: object}|{ok: false, issues: object[]}}
 */
export function validateSemanticAnswer(value, limits = SEMANTIC_ANSWER_LIMITS) {
  const collector = createIssueCollector();

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

  reportRequiredString(value, "title", "$", collector, {
    maxBytes: limits.maxTitleBytes,
    nonEmpty: true,
  });
  const body = reportRequiredString(value, "body", "$", collector, {
    maxBytes: limits.maxBodyBytes,
    nonEmpty: true,
  });
  const bodyZoomReferences = typeof body === "string" ? extractZoomReferences(body) : [];
  const bodyReferences = bodyZoomReferences.map(({ id }) => id);
  const referencedIds = new Set();
  if (bodyZoomReferences.some(({ hasRenderedText }) => !hasRenderedText)) {
    collector.add({
      code: "empty_expansion_label",
      path: "$.body",
      message: "Every expansion reference must have a visible label.",
    });
  }
  for (const expansionId of bodyReferences) {
    if (
      !EXPANSION_ID_PATTERN.test(expansionId) ||
      expansionId.length > limits.maxExpansionIdLength
    ) {
      collector.add({
        code: "invalid_expansion_reference",
        path: "$.body",
        message: `Invalid expansion reference '${expansionId}'.`,
        reference: expansionId,
      });
    } else {
      referencedIds.add(expansionId);
    }
  }

  const expansionIds = new Set();
  if (owns(value, "expansions")) {
    if (!isObject(value.expansions)) {
      collector.add({
        code: "invalid_type",
        path: "$.expansions",
        message: "expansions must be an object when present.",
        expected: "object",
      });
    } else {
      const entries = Object.entries(value.expansions);
      if (entries.length > limits.maxExpansions) {
        collector.add({
          code: "limit_exceeded",
          path: "$.expansions",
          message: `expansions contains more than ${limits.maxExpansions} entries.`,
          limit: limits.maxExpansions,
          actual: entries.length,
        });
      }

      for (const [expansionId, expansion] of entries.slice(0, limits.maxExpansions + 1)) {
        const expansionPath = `$.expansions[${JSON.stringify(expansionId)}]`;
        const safeExpansionPath = '$.expansions["<key>"]';
        const validId =
          EXPANSION_ID_PATTERN.test(expansionId) &&
          expansionId.length <= limits.maxExpansionIdLength;
        if (!validId) {
          collector.add({
            code: "invalid_expansion_id",
            path: expansionPath,
            safePath: safeExpansionPath,
            message:
              "Expansion IDs may contain only lowercase ASCII letters, digits, '.', '_', and '-'.",
          });
        } else {
          expansionIds.add(expansionId);
        }

        if (!isObject(expansion)) {
          collector.add({
            code: "invalid_type",
            path: expansionPath,
            safePath: safeExpansionPath,
            message: "Expansion must be an object.",
            expected: "object",
          });
          continue;
        }

        reportUnknownFields(expansion, EXPANSION_FIELDS, expansionPath, collector);
        if (!owns(expansion, "kind")) {
          collector.add({
            code: "required",
            path: `${expansionPath}.kind`,
            message: "kind is required.",
          });
        } else if (!EXPANSION_KINDS.has(expansion.kind)) {
          collector.add({
            code: "invalid_expansion_kind",
            path: `${expansionPath}.kind`,
            message: "kind must be definition or detail.",
            expected: "definition or detail",
          });
        }

        if (owns(expansion, "title")) {
          if (typeof expansion.title !== "string") {
            collector.add({
              code: "invalid_type",
              path: `${expansionPath}.title`,
              message: "title must be a string when present.",
              expected: "string",
            });
          } else {
            reportStringLimit(
              expansion.title,
              limits.maxExpansionTitleBytes,
              `${expansionPath}.title`,
              collector,
              "Expansion title",
            );
          }
        }

        const content = reportRequiredString(expansion, "content", expansionPath, collector, {
          maxBytes: limits.maxExpansionContentBytes,
          nonEmpty: true,
        });
        if (typeof content === "string" && extractExpansionReferences(content).length > 0) {
          collector.add({
            code: "nested_expansion_reference",
            path: `${expansionPath}.content`,
            safePath: `${safeExpansionPath}.content`,
            message: "Expansion content must not contain zoom references.",
          });
        }
      }
    }
  }

  for (const expansionId of referencedIds) {
    if (!expansionIds.has(expansionId)) {
      collector.add({
        code: "unresolved_expansion_reference",
        path: "$.body",
        message: `No expansion exists for '${expansionId}'.`,
        reference: expansionId,
      });
    }
  }
  for (const expansionId of expansionIds) {
    if (!referencedIds.has(expansionId)) {
      collector.add({
        code: "unused_expansion",
        path: `$.expansions[${JSON.stringify(expansionId)}]`,
        safePath: '$.expansions["<key>"]',
        message: `Expansion '${expansionId}' is not referenced by the body.`,
        reference: expansionId,
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

  return collector.issues.length > 0
    ? { ok: false, issues: collector.issues }
    : { ok: true, value };
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
    "sessionId",
    limits.maxSessionIdBytes,
    collector,
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
          ...(issue.safePath
            ? {
                safePath:
                  issue.safePath === "$"
                    ? "$.document"
                    : `$.document${issue.safePath.slice(1)}`,
              }
            : {}),
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
    collector.add({
      code: "not_serializable",
      path: "$",
      message: "Publication must be JSON-serializable.",
    });
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

  return collector.issues.length > 0
    ? { ok: false, issues: collector.issues }
    : { ok: true, value };
}

export function assertPublicationEnvelope(value, limits, answerLimits) {
  const result = validatePublicationEnvelope(value, limits, answerLimits);
  if (!result.ok) {
    throw new PublicationEnvelopeValidationError(result.issues);
  }
  return result.value;
}

const SAFE_ISSUE_MESSAGES = Object.freeze({
  empty_content: "Content must not be empty.",
  empty_expansion_label: "Every expansion reference must have a visible label.",
  empty_value: "The value must not be empty.",
  invalid_expansion_id: "An expansion ID is invalid.",
  invalid_expansion_kind: "An expansion kind is invalid.",
  invalid_expansion_reference: "An expansion reference is invalid.",
  invalid_type: "The value has the wrong type.",
  invalid_version: "Only SemanticAnswer version 1 is accepted.",
  limit_exceeded: "A configured size or count limit was exceeded.",
  nested_expansion_reference: "Expansion content cannot contain an expansion reference.",
  not_serializable: "The value is not JSON-serializable.",
  required: "A required value is missing.",
  too_many_errors: "Too many validation issues were found.",
  unknown_field: "An unknown field is present.",
  unresolved_expansion_reference: "An expansion reference has no matching expansion.",
  unused_expansion: "An expansion is not referenced by the body.",
});

/** Strip rejected values while retaining repairable codes and structural paths. */
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
