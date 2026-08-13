import { readFileSync } from "node:fs";
import path from "node:path";

import {
  SEMANTIC_ANSWER_TOKEN_ENV,
  resolveTokenFilePath,
  validateCapabilityToken,
} from "./capability-token.mjs";
import { SessionIdentityProvider } from "./session-identity.mjs";

export const SEMANTIC_ANSWER_SERVICE_URL_ENV = "SEMANTIC_ANSWER_SERVICE_URL";
export const DEFAULT_SERVICE_URL = "http://127.0.0.1:4318";
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function requireLoopbackServiceUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${SEMANTIC_ANSWER_SERVICE_URL_ENV} must be a valid loopback HTTP origin.`);
  }
  if (
    parsed.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${SEMANTIC_ANSWER_SERVICE_URL_ENV} must be a loopback HTTP origin.`);
  }
  return parsed.origin;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDurablePublishAcknowledgement(value) {
  return (
    isObject(value) &&
    value.ok === true &&
    typeof value.sessionId === "string" &&
    value.sessionId.trim().length > 0 &&
    typeof value.turnId === "string" &&
    value.turnId.trim().length > 0 &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0 &&
    !Object.hasOwn(value, "error")
  );
}

function invalidPublishAcknowledgementError() {
  return Object.assign(
    new Error("The local Semantic Answer service did not confirm a durable publication."),
    { code: "invalid_publish_acknowledgement" },
  );
}

function isAmbiguousPublicationError(error) {
  return (
    error?.code === "service_unavailable" ||
    error?.code === "invalid_service_response" ||
    error?.code === "invalid_publish_acknowledgement" ||
    (Number.isInteger(error?.status) && error.status >= 500)
  );
}

function toolResult(body, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    ...(isError ? { isError: true } : {}),
  };
}

function toolError(code, message, issues) {
  return toolResult(
    { ok: false, error: { code, message, ...(issues ? { issues } : {}) } },
    true,
  );
}

function safeServiceError(value, status) {
  if (isObject(value?.error) && typeof value.error.code === "string") {
    return {
      code: value.error.code,
      message:
        typeof value.error.message === "string"
          ? value.error.message
          : "The local Semantic Answer service rejected the request.",
      ...(Array.isArray(value.error.issues) ? { issues: value.error.issues } : {}),
    };
  }
  return {
    code: status === 401 ? "unauthorized" : "service_error",
    message: "The local Semantic Answer service rejected the request.",
  };
}

function loadClientToken(options, environment) {
  const explicit = options.token ?? environment[SEMANTIC_ANSWER_TOKEN_ENV];
  if (typeof explicit === "string" && explicit.trim()) {
    return validateCapabilityToken(explicit);
  }
  const dbPath = path.resolve(
    options.cwd ?? process.cwd(),
    options.dbPath ??
      environment.SEMANTIC_ANSWER_DB ??
      path.join(".semantic-answer", "semantic-transcript.sqlite3"),
  );
  const tokenFilePath = options.tokenFilePath ?? resolveTokenFilePath(dbPath, environment);
  try {
    return validateCapabilityToken(readFileSync(tokenFilePath, "utf8").trim());
  } catch (error) {
    const wrapped = new Error("The local service capability token is unavailable.", { cause: error });
    wrapped.code = "token_unavailable";
    throw wrapped;
  }
}

export class SemanticAnswerServiceClient {
  constructor(options = {}) {
    this.environment = options.environment ?? process.env;
    this.baseUrl = requireLoopbackServiceUrl(
      options.baseUrl ??
        this.environment[SEMANTIC_ANSWER_SERVICE_URL_ENV] ??
        DEFAULT_SERVICE_URL,
    );
    this.fetch = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new TypeError("requestTimeoutMs must be a positive finite number.");
    }
    this.token = loadClientToken(options, this.environment);
  }

  async request(pathname, options = {}) {
    let response;
    try {
      const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;
      response = await this.fetch(`${this.baseUrl}${pathname}`, {
        ...options,
        redirect: "error",
        signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(options.headers ?? {}),
        },
      });
    } catch (error) {
      const wrapped = new Error("The local Semantic Answer service could not be reached.", {
        cause: error,
      });
      wrapped.code = "service_unavailable";
      throw wrapped;
    }
    if (response.url) {
      let finalOrigin;
      try {
        finalOrigin = new URL(response.url).origin;
      } catch {
        const error = new Error("The local Semantic Answer service returned an invalid response URL.");
        error.code = "invalid_service_response";
        throw error;
      }
      if (finalOrigin !== this.baseUrl) {
        const error = new Error("The local Semantic Answer service response changed origin.");
        error.code = "service_origin_mismatch";
        throw error;
      }
    }
    let body;
    try {
      body = await response.json();
    } catch {
      const error = new Error("The local Semantic Answer service returned an invalid response.");
      error.code = "invalid_service_response";
      throw error;
    }
    if (!response.ok) {
      const safe = safeServiceError(body, response.status);
      const error = new Error(safe.message);
      Object.assign(error, safe, { status: response.status });
      throw error;
    }
    return body;
  }

  async publish(envelope) {
    const body = JSON.stringify(envelope);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const acknowledgment = await this.request("/api/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (!isDurablePublishAcknowledgement(acknowledgment)) {
          throw invalidPublishAcknowledgementError();
        }
        return acknowledgment;
      } catch (error) {
        if (attempt === 1 || !isAmbiguousPublicationError(error)) throw error;
      }
    }
    throw invalidPublishAcknowledgementError();
  }

  readHistory(argumentsValue) {
    const query = new URLSearchParams({ sourceSessionKey: argumentsValue.sourceSessionKey });
    if (argumentsValue.beforeSequence !== undefined) {
      query.set("beforeSequence", String(argumentsValue.beforeSequence));
    }
    if (argumentsValue.limit !== undefined) {
      query.set("limit", String(argumentsValue.limit));
    }
    return this.request(`/api/history?${query}`);
  }

  readTurn(turnId) {
    return this.request(`/api/turns/${encodeURIComponent(turnId)}`);
  }
}

function requireObject(argumentsValue) {
  if (!isObject(argumentsValue)) {
    throw Object.assign(new Error("Tool arguments must be an object."), {
      code: "invalid_tool_input",
    });
  }
  return argumentsValue;
}

function resultFromError(error, fallbackCode) {
  return toolError(
    typeof error?.code === "string" ? error.code : fallbackCode,
    error instanceof Error ? error.message : "The tool request failed.",
    Array.isArray(error?.issues) ? error.issues : undefined,
  );
}

export async function executePublishSemanticAnswer(
  argumentsValue,
  client,
  identityProvider = new SessionIdentityProvider(),
) {
  try {
    const input = identityProvider.bind(requireObject(argumentsValue));
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0) {
      return toolError(
        "missing_idempotency_key",
        "No idempotency key was supplied. Configure the Codex hook or pass idempotencyKey explicitly.",
      );
    }
    const acknowledgment = await client.publish(input);
    return toolResult(acknowledgment);
  } catch (error) {
    return resultFromError(error, "publish_failed");
  }
}

export async function executeReadSemanticHistory(
  argumentsValue,
  client,
  identityProvider = new SessionIdentityProvider(),
) {
  try {
    const input = identityProvider.bind(requireObject(argumentsValue));
    return toolResult(await client.readHistory(input));
  } catch (error) {
    return resultFromError(error, "history_read_failed");
  }
}

export async function executeReadSemanticTurn(argumentsValue, client) {
  try {
    const input = requireObject(argumentsValue);
    if (typeof input.turnId !== "string" || input.turnId.trim().length === 0) {
      return toolError("invalid_tool_input", "turnId is required.");
    }
    return toolResult(await client.readTurn(input.turnId));
  } catch (error) {
    return resultFromError(error, "turn_read_failed");
  }
}
