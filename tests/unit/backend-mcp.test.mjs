import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createSemanticAnswerHttpService } from "../../server/http-server.mjs";
import {
  HISTORY_TOOL_NAME,
  MCP_SERVER_INSTRUCTIONS,
  PUBLISH_TOOL_NAME,
  TURN_TOOL_NAME,
} from "../../server/mcp-server.mjs";
import {
  makeTemporaryDirectory,
  removeTemporaryDirectory,
  semanticDocument,
} from "./backend-test-helpers.mjs";

test(
  "MCP stdio is a thin HTTP adapter for publish, compact history, and one full turn",
  { timeout: 15_000 },
  async () => {
    const directory = await makeTemporaryDirectory("mcp-");
    const token = "c".repeat(64);
    const service = createSemanticAnswerHttpService({
      port: 0,
      dbPath: path.join(directory, "transcript.sqlite3"),
      token,
    });
    const address = await service.start();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("server", "mcp-server.mjs")],
      cwd: process.cwd(),
      env: {
        ...process.env,
        SEMANTIC_ANSWER_SERVICE_URL: `http://127.0.0.1:${address.port}`,
        SEMANTIC_ANSWER_TOKEN: token,
        SEMANTIC_ANSWER_SESSION_KEY: "codex:stdio-session",
        SEMANTIC_ANSWER_TURN_KEY: "stdio-turn-1",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "transcript-backend-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      assert.equal(client.getServerVersion()?.name, "semantic-answer");
      assert.equal(client.getInstructions(), MCP_SERVER_INSTRUCTIONS);
      assert.ok(MCP_SERVER_INSTRUCTIONS.length <= 768);
      assert.match(MCP_SERVER_INSTRUCTIONS, /never both/i);
      assert.match(MCP_SERVER_INSTRUCTIONS, /concise[^.]*body|body[^.]*stand/i);
      assert.doesNotMatch(MCP_SERVER_INSTRUCTIONS, /tree|term:|density/i);

      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name),
        [PUBLISH_TOOL_NAME, HISTORY_TOOL_NAME, TURN_TOOL_NAME],
      );
      assert.equal(tools.tools[0].inputSchema.additionalProperties, false);
      assert.deepEqual(tools.tools[0].inputSchema.required, ["requestSummary", "document"]);
      assert.deepEqual(tools.tools[0].inputSchema.$defs.semanticAnswer.required, [
        "version",
        "title",
        "body",
      ]);
      assert.equal(
        tools.tools[0].inputSchema.$defs.semanticExpansion.properties.kind.enum.join(","),
        "definition,detail",
      );
      assert.deepEqual(Object.keys(tools.tools[1].inputSchema.properties).sort(), [
        "beforeSequence",
        "limit",
        "sourceSessionKey",
      ]);
      assert.equal(Object.hasOwn(tools.tools[1].inputSchema.properties, "detail"), false);

      const secret = "MCP-PUBLISHED-ANSWER-BODY";
      const published = await client.callTool({
        name: PUBLISH_TOOL_NAME,
        arguments: {
          requestSummary: "Publish the MCP integration result",
          document: semanticDocument(secret, "MCP integration"),
          idempotencyKey: "stdio-idempotency-1",
        },
      });
      assert.equal(published.isError, undefined);
      assert.equal(published.structuredContent.ok, true);
      assert.doesNotMatch(JSON.stringify(published), new RegExp(secret));

      const retried = await client.callTool({
        name: PUBLISH_TOOL_NAME,
        arguments: {
          requestSummary: "Publish the MCP integration result",
          document: semanticDocument(secret, "MCP integration"),
          idempotencyKey: "stdio-idempotency-1",
        },
      });
      assert.deepEqual(retried.structuredContent, published.structuredContent);

      const keyCanary = "MCP_PRIVATE_UNKNOWN_KEY_CANARY";
      const invalid = await client.callTool({
        name: PUBLISH_TOOL_NAME,
        arguments: {
          requestSummary: "Invalid publication",
          document: {
            version: 1,
            title: "Invalid",
            body: "Do not echo keys",
            [keyCanary]: true,
          },
          idempotencyKey: "stdio-invalid-idempotency",
          [keyCanary]: true,
        },
      });
      assert.equal(invalid.isError, true);
      assert.equal(invalid.structuredContent.error.code, "invalid_publish_envelope");
      assert.doesNotMatch(JSON.stringify(invalid), new RegExp(keyCanary));

      const history = await client.callTool({ name: HISTORY_TOOL_NAME, arguments: {} });
      assert.equal(Object.hasOwn(history.structuredContent, "detail"), false);
      assert.equal(history.structuredContent.turns.length, 1);
      assert.deepEqual(history.structuredContent.turns[0].answer, {
        version: 1,
        title: "MCP integration",
        body: secret,
      });

      const full = await client.callTool({
        name: TURN_TOOL_NAME,
        arguments: { turnId: published.structuredContent.turnId },
      });
      assert.equal(full.structuredContent.turn.answer.body, secret);
    } finally {
      await client.close().catch(() => {});
      await service.stop();
      await removeTemporaryDirectory(directory);
    }
  },
);
