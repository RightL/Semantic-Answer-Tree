import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  SemanticAnswerServiceClient,
  executePublishSemanticAnswer,
  executeReadSemanticHistory,
  executeReadSemanticTurn,
} from "./publisher.mjs";
import { SessionIdentityProvider } from "./session-identity.mjs";

export const PUBLISH_TOOL_NAME = "publish_semantic_answer";
export const HISTORY_TOOL_NAME = "read_semantic_history";
export const TURN_TOOL_NAME = "read_semantic_turn";

export const MCP_SERVER_INSTRUCTIONS =
  "Publish one complete SemanticAnswer v1 tree per final answer. The integration owns identity, idempotency, acknowledgement checks, and ambiguous-delivery recovery. A side chat may receive an isolated temporary session; never reuse the main task identity. Correct validation once at most. On confirmed success, reply exactly: Rendered in Semantic Answer Tree. If success is unconfirmed, give the complete ordinary answer instead—never both. History is read-only and compact by default.";

const SEMANTIC_ANSWER_SCHEMA = {
  type: "object",
  properties: {
    version: { const: 1 },
    title: { type: "string" },
    root: { $ref: "#/$defs/semanticNode" },
    terms: {
      type: "object",
      propertyNames: { pattern: "^[a-z0-9._-]+$", maxLength: 128 },
      additionalProperties: { type: "string" },
    },
  },
  required: ["version", "title", "root"],
  additionalProperties: false,
};

const SEMANTIC_NODE_SCHEMA = {
  type: "object",
  properties: {
    content: { type: "string", minLength: 1 },
    children: { type: "array", items: { $ref: "#/$defs/semanticNode" } },
  },
  required: ["content"],
  additionalProperties: false,
};

export const PUBLISH_TOOL_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    sourceSessionKey: { type: "string", minLength: 1, maxLength: 1024 },
    sourceTurnKey: { type: "string", minLength: 1, maxLength: 1024 },
    requestSummary: { type: "string", minLength: 1, maxLength: 16384 },
    document: { $ref: "#/$defs/semanticAnswer" },
    idempotencyKey: { type: "string", minLength: 1, maxLength: 512 },
  },
  required: ["requestSummary", "document"],
  additionalProperties: false,
  $defs: {
    semanticAnswer: SEMANTIC_ANSWER_SCHEMA,
    semanticNode: SEMANTIC_NODE_SCHEMA,
  },
});

export const HISTORY_TOOL_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    sourceSessionKey: { type: "string", minLength: 1, maxLength: 1024 },
    beforeSequence: { type: "integer", minimum: 1 },
    limit: { type: "integer", minimum: 1, maximum: 50 },
    detail: { type: "string", enum: ["roots", "frontier"] },
  },
  additionalProperties: false,
});

export const TURN_TOOL_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: { turnId: { type: "string", minLength: 1, maxLength: 128 } },
  required: ["turnId"],
  additionalProperties: false,
});

function isMainModule(metaUrl) {
  return Boolean(process.argv[1]) && metaUrl === pathToFileURL(path.resolve(process.argv[1])).href;
}

function unknownToolResult() {
  const body = { ok: false, error: { code: "unknown_tool", message: "Unknown tool." } };
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    isError: true,
  };
}

export async function runMcpServer(options = {}) {
  const [{ Server }, { StdioServerTransport }, protocol] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);

  const client = options.client ?? new SemanticAnswerServiceClient(options);
  const identityProvider =
    options.identityProvider ?? new SessionIdentityProvider({ environment: options.environment });
  const server = new Server(
    { name: "semantic-answer-tree", version: "2.0.0" },
    { capabilities: { tools: {} }, instructions: MCP_SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(protocol.ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: PUBLISH_TOOL_NAME,
        description:
          "Append one validated SemanticAnswer v1 turn to the caller's local transcript.",
        inputSchema: PUBLISH_TOOL_INPUT_SCHEMA,
      },
      {
        name: HISTORY_TOOL_NAME,
        description: "Read compact root or frontier history for the caller's session.",
        inputSchema: HISTORY_TOOL_INPUT_SCHEMA,
      },
      {
        name: TURN_TOOL_NAME,
        description: "Read one complete immutable semantic turn by answer-tree turn ID.",
        inputSchema: TURN_TOOL_INPUT_SCHEMA,
      },
    ],
  }));

  server.setRequestHandler(protocol.CallToolRequestSchema, async (request) => {
    if (request.params.name === PUBLISH_TOOL_NAME) {
      return executePublishSemanticAnswer(request.params.arguments, client, identityProvider);
    }
    if (request.params.name === HISTORY_TOOL_NAME) {
      return executeReadSemanticHistory(request.params.arguments, client, identityProvider);
    }
    if (request.params.name === TURN_TOOL_NAME) {
      return executeReadSemanticTurn(request.params.arguments, client);
    }
    return unknownToolResult();
  });

  const transport = options.transport ?? new StdioServerTransport();
  await server.connect(transport);
  return server;
}

if (isMainModule(import.meta.url)) {
  runMcpServer().catch((error) => {
    // stdout is reserved for JSON-RPC.
    console.error(error instanceof Error ? error.message : "Semantic Answer MCP server failed.");
    process.exitCode = 1;
  });
}
