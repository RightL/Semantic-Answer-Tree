import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const testTempRoot = path.resolve(
  process.env.SEMANTIC_TRANSCRIPT_TEST_TEMP_ROOT ?? path.join(projectRoot, "tmp"),
);
const runId =
  process.env.SEMANTIC_TRANSCRIPT_TEST_RUN_ID ??
  `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const runDirectory = path.join(
  testTempRoot,
  `semantic-transcript-playwright-${runId}`,
);
const chromiumLogFile = path.join(runDirectory, "runtime", "chromium-debug.log");

// Global setup and Playwright workers inherit these values. The setup fills in
// the dynamic viewer/API URLs after both loopback servers have started.
process.env.SEMANTIC_TRANSCRIPT_TEST_RUN_ID = runId;
process.env.SEMANTIC_TRANSCRIPT_TEST_DIR = runDirectory;
process.env.CHROME_LOG_FILE = chromiumLogFile;
const browserEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string",
  ),
);
browserEnvironment.CHROME_LOG_FILE = chromiumLogFile;

export default defineConfig({
  testDir: "./tests",
  testMatch: ["browser/**/*.spec.ts", "performance/**/*.spec.ts"],
  globalSetup: "./tests/browser/global-setup.mjs",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  outputDir: path.join(runDirectory, "test-results"),
  expect: {
    timeout: 7_500,
  },
  reporter: process.env.CI ? "github" : "list",
  use: {
    launchOptions: {
      args: [`--log-file=${chromiumLogFile}`],
      env: browserEnvironment,
    },
    trace: "retain-on-failure",
  },
});
