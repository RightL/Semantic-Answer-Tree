import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer as createViteServer } from "vite";

import { createSemanticAnswerHttpService } from "../../server/http-server.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

function loopbackUrl(address) {
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP address from the local test server.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function reserveLoopbackPort() {
  const reservation = net.createServer();
  const address = await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => resolve(reservation.address()));
  });
  await new Promise((resolve, reject) => {
    reservation.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve a dynamic viewer port.");
  }
  return address.port;
}

async function removeRuntimeDirectory(runtimeDirectory) {
  const configuredRunDirectory = path.resolve(
    process.env.SEMANTIC_TRANSCRIPT_TEST_DIR ?? "",
  );
  const resolvedRuntimeDirectory = path.resolve(runtimeDirectory);
  if (
    !resolvedRuntimeDirectory.startsWith(`${configuredRunDirectory}${path.sep}`) ||
    path.basename(resolvedRuntimeDirectory) !== "runtime"
  ) {
    throw new Error("Refusing to clean an unexpected browser-test directory.");
  }
  await rm(resolvedRuntimeDirectory, {
    force: true,
    maxRetries: 8,
    recursive: true,
    retryDelay: 125,
  });
}

export default async function globalSetup() {
  const runDirectory = process.env.SEMANTIC_TRANSCRIPT_TEST_DIR;
  if (!runDirectory) {
    throw new Error("Playwright config did not provide a unique test directory.");
  }

  const runtimeDirectory = path.join(runDirectory, "runtime");
  const databasePath = path.join(runtimeDirectory, "semantic-transcript.sqlite");
  const tokenFilePath = path.join(runtimeDirectory, "capability.token");
  const capabilityToken = randomBytes(32).toString("base64url");
  const viewerPort = await reserveLoopbackPort();
  const viewerOrigin = `http://127.0.0.1:${viewerPort}`;

  await mkdir(runtimeDirectory, { recursive: true });

  process.env.SEMANTIC_ANSWER_BROWSER_TEST = "1";
  process.env.SEMANTIC_ANSWER_DB = databasePath;
  process.env.SEMANTIC_ANSWER_TOKEN = capabilityToken;
  process.env.SEMANTIC_ANSWER_TOKEN_FILE = tokenFilePath;

  const publisher = createSemanticAnswerHttpService({
    databasePath,
    dbPath: databasePath,
    allowedOrigins: [viewerOrigin],
    port: 0,
    token: capabilityToken,
    tokenFilePath,
  });

  let viewer;
  try {
    const publisherAddress = await publisher.start();
    const apiBaseUrl = loopbackUrl(publisherAddress);
    process.env.SEMANTIC_ANSWER_API_BASE = apiBaseUrl;
    process.env.SEMANTIC_ANSWER_SERVICE_URL = apiBaseUrl;
    process.env.NEXT_PUBLIC_SEMANTIC_ANSWER_API = apiBaseUrl;

    viewer = await createViteServer({
      configFile: path.join(projectRoot, "vite.config.ts"),
      root: projectRoot,
      server: {
        host: "127.0.0.1",
        port: viewerPort,
        strictPort: true,
      },
    });
    await viewer.listen();

    const viewerAddress = viewer.httpServer?.address();
    process.env.SEMANTIC_TRANSCRIPT_TEST_VIEWER_URL = loopbackUrl(viewerAddress);
  } catch (error) {
    try {
      await viewer?.close();
    } finally {
      await publisher.stop().catch(() => {});
      await removeRuntimeDirectory(runtimeDirectory).catch(() => {});
    }
    throw error;
  }

  return async () => {
    try {
      await viewer.close();
    } finally {
      try {
        // stop() closes SSE clients, the HTTP listener, and the SQLite owner.
        await publisher.stop();
      } finally {
        // Do not retain the database, WAL/SHM files, or random capability.
        await removeRuntimeDirectory(runtimeDirectory);
      }
    }
  };
}
