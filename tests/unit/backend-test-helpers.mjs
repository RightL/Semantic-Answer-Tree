import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const testTempRoot = path.resolve(
  process.env.SEMANTIC_TRANSCRIPT_TEST_TEMP_ROOT ?? path.join(projectRoot, "tmp"),
);

export const TRANSCRIPT_TEST_TEMP_ROOT = path.join(
  testTempRoot,
  "semantic-transcript-backend-tests",
);

export function semanticDocument(content = "A valid answer.", title = "Backend test") {
  return { version: 1, title, body: content };
}

export function publication(overrides = {}) {
  return {
    sessionId: "sa-session-test",
    requestSummary: "Test the transcript backend",
    document: semanticDocument(),
    idempotencyKey: "idempotency:test:1",
    ...overrides,
  };
}

export async function makeTemporaryDirectory(prefix = "case-") {
  await mkdir(TRANSCRIPT_TEST_TEMP_ROOT, { recursive: true });
  return mkdtemp(path.join(TRANSCRIPT_TEST_TEMP_ROOT, prefix));
}

export async function removeTemporaryDirectory(directory) {
  await rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 30 });
}

export async function readSseUntil(reader, predicate, timeoutMs = 3_000) {
  const decoder = new TextDecoder();
  let received = "";
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Timed out waiting for SSE data.")), timeoutMs);
    timeout.unref?.();
  });
  try {
    while (!predicate(received)) {
      const { value, done } = await Promise.race([reader.read(), timeoutPromise]);
      if (done) {
        break;
      }
      received += decoder.decode(value, { stream: true });
    }
    return received;
  } finally {
    clearTimeout(timeout);
  }
}
