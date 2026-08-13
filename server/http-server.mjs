import http from "node:http";

import {
  bearerToken,
  capabilityTokenMatches,
  loadOrCreateCapabilityToken,
} from "./capability-token.mjs";
import {
  PUBLICATION_ENVELOPE_LIMITS,
  PublicationEnvelopeValidationError,
  SEMANTIC_ANSWER_LIMITS,
  sanitizeValidationIssues,
} from "./validation.mjs";
import {
  SemanticTranscriptError,
  SemanticTranscriptStore,
  resolveDatabasePath,
} from "./store.mjs";

export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 4318;
export const SEMANTIC_ANSWER_PORT_ENV = "SEMANTIC_ANSWER_PORT";
export const SEMANTIC_ANSWER_VIEWER_ORIGINS_ENV = "SEMANTIC_ANSWER_VIEWER_ORIGINS";
export const DEFAULT_VIEWER_ORIGINS = Object.freeze([
  "http://localhost:4173",
  "http://127.0.0.1:4173",
]);
export const MAX_HTTP_BODY_BYTES =
  SEMANTIC_ANSWER_LIMITS.maxDocumentBytes +
  PUBLICATION_ENVELOPE_LIMITS.maxEnvelopeOverheadBytes;

class HttpRequestError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "HttpRequestError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${SEMANTIC_ANSWER_PORT_ENV} must be an integer from 0 through 65535.`);
  }
  return port;
}

export function resolveHttpPort(environment = process.env) {
  return parsePort(environment[SEMANTIC_ANSWER_PORT_ENV] ?? DEFAULT_HTTP_PORT);
}

export function resolveAllowedOrigins(environment = process.env) {
  const configured = environment[SEMANTIC_ANSWER_VIEWER_ORIGINS_ENV];
  if (!configured) {
    return [...DEFAULT_VIEWER_ORIGINS];
  }
  const origins = configured
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    throw new Error(`${SEMANTIC_ANSWER_VIEWER_ORIGINS_ENV} must contain at least one origin.`);
  }
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
      parsed.origin !== origin
    ) {
      throw new Error(`${SEMANTIC_ANSWER_VIEWER_ORIGINS_ENV} may contain exact loopback origins only.`);
    }
  }
  return [...new Set(origins)];
}

export function isAllowedOrigin(origin, allowedOrigins = DEFAULT_VIEWER_ORIGINS) {
  return origin === undefined || allowedOrigins.includes(origin);
}

function applyCors(request, response, allowedOrigins) {
  const origin = request.headers.origin;
  if (!isAllowedOrigin(origin, allowedOrigins)) {
    return false;
  }
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  return true;
}

function securityHeaders() {
  return {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function writeJson(response, statusCode, body, extraHeaders = {}) {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(serialized),
    ...extraHeaders,
  });
  response.end(serialized);
}

function errorBody(code, message, issues) {
  return {
    ok: false,
    error: { code, message, ...(issues ? { issues } : {}) },
  };
}

function readJsonBody(request, maxBytes = MAX_HTTP_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(request.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      reject(new HttpRequestError(413, "body_too_large", `Request body exceeds ${maxBytes} bytes.`));
      return;
    }
    const chunks = [];
    let byteCount = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      if (tooLarge) {
        return;
      }
      byteCount += chunk.length;
      if (byteCount > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      if (tooLarge) {
        reject(new HttpRequestError(413, "body_too_large", `Request body exceeds ${maxBytes} bytes.`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpRequestError(400, "invalid_json", "Request body must be valid JSON."));
      }
    });
  });
}

function parseRequestUrl(request) {
  try {
    return new URL(request.url ?? "/", `http://${DEFAULT_HTTP_HOST}`);
  } catch {
    throw new HttpRequestError(400, "invalid_url", "Request URL is invalid.");
  }
}

function parsePositiveInteger(value, name) {
  if (value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HttpRequestError(400, "invalid_query", `${name} must be a positive integer.`);
  }
  return parsed;
}

function isAuthorized(request, token) {
  return capabilityTokenMatches(bearerToken(request.headers.authorization), token);
}

function requireAuthorization(request, token) {
  if (!isAuthorized(request, token)) {
    throw new HttpRequestError(401, "unauthorized", "A valid local capability token is required.");
  }
}

function createSseHub(store) {
  const clients = new Set();

  function send(response, event, data, id) {
    if (id) {
      response.write(`id: ${id}\n`);
    }
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  const unsubscribe = store.onTurnPublished((event) => {
    for (const response of clients) {
      send(response, "turn-published", event, event.eventId);
    }
  });

  return {
    connect(request, response) {
      response.writeHead(200, {
        ...securityHeaders(),
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders?.();
      clients.add(response);
      send(response, "ready", { ok: true });

      const lastEventId = request.headers["last-event-id"];
      if (typeof lastEventId === "string" && lastEventId.length > 0) {
        for (const event of store.eventsAfter(lastEventId)) {
          send(response, "turn-published", event, event.eventId);
        }
      }

      const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 25_000);
      heartbeat.unref?.();
      const disconnect = () => {
        clearInterval(heartbeat);
        clients.delete(response);
      };
      request.once("close", disconnect);
      response.once("close", disconnect);
    },
    close() {
      unsubscribe();
      for (const response of clients) {
        response.end();
      }
      clients.clear();
    },
  };
}

function routeIdentifier(pathname, pattern) {
  const match = pathname.match(pattern);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new HttpRequestError(400, "invalid_url", "Route identifier is invalid.");
  }
}

export function createSemanticAnswerHttpService(options = {}) {
  const environment = options.environment ?? process.env;
  const host = options.host ?? DEFAULT_HTTP_HOST;
  if (host !== DEFAULT_HTTP_HOST) {
    throw new Error(`Semantic Answer HTTP service must bind to ${DEFAULT_HTTP_HOST}.`);
  }
  const port = parsePort(options.port ?? DEFAULT_HTTP_PORT);
  const dbPath = options.dbPath ?? resolveDatabasePath(environment, options.cwd);
  const store =
    options.store ??
    new SemanticTranscriptStore({
      dbPath,
      environment,
      cwd: options.cwd,
    });
  const capability = loadOrCreateCapabilityToken({
    token: options.token,
    tokenFilePath: options.tokenFilePath,
    dbPath: store.dbPath,
    environment,
  });
  const allowedOrigins = options.allowedOrigins ?? resolveAllowedOrigins(environment);
  const sse = createSseHub(store);
  let started = false;
  let stopped = false;

  const server = http.createServer((request, response) => {
    void (async () => {
      if (!applyCors(request, response, allowedOrigins)) {
        writeJson(response, 403, errorBody("origin_forbidden", "This browser origin is not allowed."));
        return;
      }
      const url = parseRequestUrl(request);
      const pathname = url.pathname;

      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          ...securityHeaders(),
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Max-Age": "600",
        });
        response.end();
        return;
      }

      if (pathname === "/health" && request.method === "GET") {
        writeJson(response, 200, { ok: true });
        return;
      }
      if (pathname === "/api/sessions" && request.method === "GET") {
        writeJson(response, 200, { sessions: store.listSessions() });
        return;
      }

      const sessionId = routeIdentifier(pathname, /^\/api\/sessions\/([^/]+)\/turns$/);
      if (sessionId !== null && request.method === "GET") {
        const page = store.getTurnsPage(sessionId, {
          beforeSequence: parsePositiveInteger(url.searchParams.get("beforeSequence"), "beforeSequence"),
          afterSequence: parsePositiveInteger(url.searchParams.get("afterSequence"), "afterSequence"),
          limit: parsePositiveInteger(url.searchParams.get("limit"), "limit"),
        });
        writeJson(response, 200, page);
        return;
      }

      const turnId = routeIdentifier(pathname, /^\/api\/turns\/([^/]+)$/);
      if (turnId !== null && request.method === "GET") {
        writeJson(response, 200, { turn: store.getTurn(turnId) });
        return;
      }

      if (pathname === "/api/history" && request.method === "GET") {
        requireAuthorization(request, capability.token);
        const sourceSessionKey = url.searchParams.get("sourceSessionKey");
        if (!sourceSessionKey?.trim()) {
          throw new HttpRequestError(400, "invalid_query", "sourceSessionKey is required.");
        }
        const history = store.readHistory(sourceSessionKey, {
          beforeSequence: parsePositiveInteger(url.searchParams.get("beforeSequence"), "beforeSequence"),
          limit: parsePositiveInteger(url.searchParams.get("limit"), "limit"),
        });
        writeJson(response, 200, history);
        return;
      }

      if (pathname === "/api/publish" && request.method === "POST") {
        // Authentication intentionally precedes content-type checks and body parsing.
        requireAuthorization(request, capability.token);
        const contentType = request.headers["content-type"] ?? "";
        if (!contentType.toLowerCase().startsWith("application/json")) {
          throw new HttpRequestError(
            415,
            "unsupported_media_type",
            "Content-Type must be application/json.",
          );
        }
        const envelope = await readJsonBody(request, options.maxBodyBytes ?? MAX_HTTP_BODY_BYTES);
        writeJson(response, 200, store.publish(envelope));
        return;
      }

      if (pathname === "/events" && request.method === "GET") {
        sse.connect(request, response);
        return;
      }

      const knownRoute =
        ["/health", "/api/sessions", "/api/history", "/api/publish", "/events"].includes(pathname) ||
        sessionId !== null ||
        turnId !== null;
      if (knownRoute) {
        writeJson(response, 405, errorBody("method_not_allowed", "Method not allowed."));
        return;
      }
      writeJson(response, 404, errorBody("not_found", "Route not found."));
    })().catch((error) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof HttpRequestError) {
        writeJson(response, error.statusCode, errorBody(error.code, error.message));
      } else if (error instanceof PublicationEnvelopeValidationError) {
        writeJson(
          response,
          400,
          errorBody(error.code, error.message, sanitizeValidationIssues(error.issues)),
        );
      } else if (error instanceof SemanticTranscriptError) {
        writeJson(response, error.statusCode, errorBody(error.code, error.message));
      } else {
        writeJson(response, 500, errorBody("internal_error", "The request could not be completed."));
      }
    });
  });

  return {
    server,
    store,
    token: capability.token,
    tokenFilePath: capability.tokenFilePath,
    async start() {
      if (started) {
        return server.address();
      }
      if (stopped) {
        throw new Error("A stopped Semantic Answer service cannot be restarted.");
      }
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.off("error", onError);
          resolve();
        });
      });
      started = true;
      return server.address();
    },
    async stop() {
      if (stopped) {
        return;
      }
      sse.close();
      if (started) {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      store.close();
      started = false;
      stopped = true;
    },
  };
}
