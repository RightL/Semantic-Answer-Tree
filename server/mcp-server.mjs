import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  SemanticAnswerServiceClient,
  executePublishSemanticAnswer,
  executeReadSemanticHistory,
  executeReadSemanticTurn,
} from "./publisher.mjs";

export const PUBLISH_TOOL_NAME = "publish_semantic_answer";
export const HISTORY_TOOL_NAME = "read_semantic_history";
export const TURN_TOOL_NAME = "read_semantic_turn";

export const MCP_SERVER_INSTRUCTIONS =
  "Choose one opaque sessionId on the first Semantic Answer call in a Codex session; reuse it for every publish and history call there. A side chat chooses a different ID. Publish one complete SemanticAnswer v1 per final answer: a concise, self-contained Markdown body with optional sparse [text](zoom:id) expansions. Every reference must resolve, every expansion must be used, and expansions cannot contain zoom links. The adapter owns idempotency and ambiguous-delivery recovery. Correct validation once at most. After confirmed success, reply exactly: Rendered in Semantic Answer. Without confirmation, give the complete ordinary answer instead—never both. History omits expansions.";

const SEMANTIC_ANSWER_SCHEMA = {
  type: "object",
  properties: {
    version: { const: 1 },
    title: { type: "string", minLength: 1 },
    body: {
      type: "string",
      minLength: 1,
      description: "The complete concise answer in linear Markdown, with optional zoom: links.",
    },
    expansions: {
      type: "object",
      propertyNames: { pattern: "^[a-z0-9._-]+$", maxLength: 128 },
      additionalProperties: { $ref: "#/$defs/semanticExpansion" },
      maxProperties: 500,
    },
  },
  required: ["version", "title", "body"],
  additionalProperties: false,
};

const SEMANTIC_EXPANSION_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["definition", "detail"] },
    title: { type: "string" },
    content: {
      type: "string",
      minLength: 1,
      description: "Markdown expansion content. zoom: links are not allowed here.",
    },
  },
  required: ["kind", "content"],
  additionalProperties: false,
};

export const PUBLISH_TOOL_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    sessionId: { type: "string", minLength: 1, maxLength: 128 },
    requestSummary: { type: "string", minLength: 1, maxLength: 16384 },
    document: { $ref: "#/$defs/semanticAnswer" },
  },
  required: ["sessionId", "requestSummary", "document"],
  additionalProperties: false,
  $defs: {
    semanticAnswer: SEMANTIC_ANSWER_SCHEMA,
    semanticExpansion: SEMANTIC_EXPANSION_SCHEMA,
  },
});

export const HISTORY_TOOL_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    sessionId: { type: "string", minLength: 1, maxLength: 128 },
    beforeSequence: { type: "integer", minimum: 1 },
    limit: { type: "integer", minimum: 1, maximum: 50 },
  },
  required: ["sessionId"],
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
  const server = new Server(
    { name: "semantic-answer", version: "3.0.0" },
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
        description:
          "Read compact Semantic Answer history for the caller's session. Each answer contains only version, title, and body; use read_semantic_turn for expansions.",
        inputSchema: HISTORY_TOOL_INPUT_SCHEMA,
      },
      {
        name: TURN_TOOL_NAME,
        description: "Read one complete immutable Semantic Answer turn by turn ID.",
        inputSchema: TURN_TOOL_INPUT_SCHEMA,
      },
    ],
  }));

  server.setRequestHandler(protocol.CallToolRequestSchema, async (request) => {
    if (request.params.name === PUBLISH_TOOL_NAME) {
      return executePublishSemanticAnswer(request.params.arguments, client);
    }
    if (request.params.name === HISTORY_TOOL_NAME) {
      return executeReadSemanticHistory(request.params.arguments, client);
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
