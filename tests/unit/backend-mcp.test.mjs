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
      assert.deepEqual(tools.tools[0].inputSchema.required, [
        "sessionId",
        "requestSummary",
        "document",
      ]);
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
        "sessionId",
      ]);
      assert.deepEqual(tools.tools[1].inputSchema.required, ["sessionId"]);
      assert.equal(Object.hasOwn(tools.tools[1].inputSchema.properties, "detail"), false);

      const secret = "MCP-PUBLISHED-ANSWER-BODY";
      const published = await client.callTool({
        name: PUBLISH_TOOL_NAME,
        arguments: {
          sessionId: "sa-stdio-session",
          requestSummary: "Publish the MCP integration result",
          document: semanticDocument(secret, "MCP integration"),
        },
      });
      assert.equal(published.isError, undefined);
      assert.equal(published.structuredContent.ok, true);
      assert.doesNotMatch(JSON.stringify(published), new RegExp(secret));

      const second = await client.callTool({
        name: PUBLISH_TOOL_NAME,
        arguments: {
          sessionId: "sa-stdio-session",
          requestSummary: "Publish a second result in the same session",
          document: semanticDocument(secret, "MCP integration"),
        },
      });
      assert.equal(second.structuredContent.sessionId, published.structuredContent.sessionId);
      assert.equal(second.structuredContent.sequence, 2);

      const keyCanary = "MCP_PRIVATE_UNKNOWN_KEY_CANARY";
      const invalid = await client.callTool({
        name: PUBLISH_TOOL_NAME,
        arguments: {
          sessionId: "sa-stdio-session",
          requestSummary: "Invalid publication",
          document: {
            version: 1,
            title: "Invalid",
            body: "Do not echo keys",
            [keyCanary]: true,
          },
          [keyCanary]: true,
        },
      });
      assert.equal(invalid.isError, true);
      assert.equal(invalid.structuredContent.error.code, "invalid_tool_input");
      assert.doesNotMatch(JSON.stringify(invalid), new RegExp(keyCanary));

      const history = await client.callTool({
        name: HISTORY_TOOL_NAME,
        arguments: { sessionId: "sa-stdio-session" },
      });
      assert.equal(Object.hasOwn(history.structuredContent, "detail"), false);
      assert.equal(history.structuredContent.turns.length, 2);
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
