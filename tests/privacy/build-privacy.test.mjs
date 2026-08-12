import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertBuildPrivacy,
  scanBuildPrivacy,
} from "../../scripts/check-build-privacy.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const tempRoot = path.resolve(
  process.env.SEMANTIC_TRANSCRIPT_TEST_TEMP_ROOT ?? path.join(projectRoot, "tmp"),
);

async function createTestDirectory() {
  await mkdir(tempRoot, { recursive: true });
  return mkdtemp(path.join(tempRoot, "semantic-transcript-privacy-"));
}

async function cleanFixture(rootDirectory) {
  const distDirectory = path.join(rootDirectory, "dist");
  await mkdir(distDirectory, { recursive: true });
  await writeFile(
    path.join(distDirectory, "demo-transcript.json"),
    JSON.stringify({ fixture: "sanitized-demo", sessions: [] }),
  );
  await writeFile(path.join(distDirectory, "index.js"), "export const safe = true;\n");
  return distDirectory;
}

function writeTarText(buffer, offset, length, value) {
  Buffer.from(value).copy(buffer, offset, 0, length);
}

function tarOctal(value, length) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function tarGzip(entries) {
  const blocks = [];
  for (const [name, value] of entries) {
    const contents = Buffer.from(value);
    const header = Buffer.alloc(512);
    writeTarText(header, 0, 100, name);
    writeTarText(header, 100, 8, tarOctal(0o644, 8));
    writeTarText(header, 108, 8, tarOctal(0, 8));
    writeTarText(header, 116, 8, tarOctal(0, 8));
    writeTarText(header, 124, 12, tarOctal(contents.length, 12));
    writeTarText(header, 136, 12, tarOctal(0, 12));
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeTarText(header, 257, 6, "ustar\0");
    writeTarText(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, contents, Buffer.alloc((512 - (contents.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test("allows a sanitized demo fixture and ordinary build assets", async () => {
  const rootDirectory = await createTestDirectory();
  try {
    const distDirectory = await cleanFixture(rootDirectory);
    const result = await assertBuildPrivacy({
      checkGitTracked: false,
      distDirectory,
      projectRoot: rootDirectory,
    });
    assert.equal(result.findings.length, 0);
    assert.equal(result.scannedFiles, 2);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true, maxRetries: 4 });
  }
});

test("rejects legacy answer, SQLite, env, token, path, and configured canary leaks", async () => {
  const rootDirectory = await createTestDirectory();
  const privateCanary = `PRIVATE-CANARY-${randomUUID()}`;
  const capability = `CAPABILITY-${randomUUID()}`;
  try {
    const distDirectory = await cleanFixture(rootDirectory);
    await writeFile(path.join(distDirectory, "latest-answer.json"), "{}");
    await writeFile(
      path.join(distDirectory, "semantic-transcript.sqlite"),
      Buffer.from("SQLite format 3\0private"),
    );
    await writeFile(path.join(distDirectory, ".env.production"), "EXAMPLE=unsafe\n");
    await writeFile(path.join(distDirectory, "capability.token"), capability);
    await writeFile(
      path.join(distDirectory, "private.js"),
      `${rootDirectory}\n${privateCanary}\n${capability}`,
    );

    const result = await scanBuildPrivacy({
      canaries: [privateCanary],
      checkGitTracked: false,
      distDirectory,
      environment: { ...process.env, SEMANTIC_ANSWER_TOKEN: capability },
      projectRoot: rootDirectory,
    });
    const reasons = result.findings.map((finding) => finding.reason).join("\n");
    assert.match(reasons, /legacy latest-answer/);
    assert.match(reasons, /SQLite/);
    assert.match(reasons, /environment files/);
    assert.match(reasons, /runtime capability material/);
    assert.match(reasons, /absolute workspace path/);
    assert.match(reasons, /configured private canary/);
    assert.match(reasons, /configured capability token/);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true, maxRetries: 4 });
  }
});

test("scans the packaged Sites tarball as well as dist", async () => {
  const rootDirectory = await createTestDirectory();
  const privateCanary = `ARCHIVE-ONLY-${randomUUID()}`;
  try {
    const distDirectory = await cleanFixture(rootDirectory);
    const archivePath = path.join(rootDirectory, "site.tar.gz");
    await writeFile(
      archivePath,
      tarGzip([
        ["dist/server/index.js", `export default ${JSON.stringify(privateCanary)};`],
        ["dist/.openai/hosting.json", "{}"],
      ]),
    );

    await assert.rejects(
      assertBuildPrivacy({
        archivePaths: [archivePath],
        canaries: [privateCanary],
        checkGitTracked: false,
        distDirectory,
        projectRoot: rootDirectory,
      }),
      /archive:dist\/server\/index\.js: configured private canary was embedded/,
    );
  } finally {
    await rm(rootDirectory, { recursive: true, force: true, maxRetries: 4 });
  }
});

test("rejects runtime database or token files tracked by git", async () => {
  const rootDirectory = await createTestDirectory();
  try {
    const distDirectory = await cleanFixture(rootDirectory);
    execFileSync("git", ["init", "--quiet"], { cwd: rootDirectory });
    await writeFile(path.join(rootDirectory, "runtime.sqlite"), "not-even-a-real-db");
    await writeFile(path.join(rootDirectory, "auth.token"), "not-a-real-token");
    execFileSync("git", ["add", "runtime.sqlite", "auth.token"], {
      cwd: rootDirectory,
    });

    const result = await scanBuildPrivacy({
      distDirectory,
      projectRoot: rootDirectory,
    });
    const artifacts = result.findings.map((finding) => finding.artifact);
    assert.ok(artifacts.includes("git:runtime.sqlite"));
    assert.ok(artifacts.includes("git:auth.token"));
  } finally {
    await rm(rootDirectory, { recursive: true, force: true, maxRetries: 4 });
  }
});
