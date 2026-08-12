#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import {
  lstat,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(scriptDirectory, "..");

const FORBIDDEN_ARTIFACT_PATHS = [
  {
    reason: "legacy latest-answer data is not a deployable fixture",
    test: (normalizedPath) => path.posix.basename(normalizedPath) === "latest-answer.json",
  },
  {
    reason: "runtime SQLite data must never be bundled",
    test: (normalizedPath) =>
      /(?:^|\/)[^/]+\.(?:sqlite|sqlite3|db|db3)$/.test(normalizedPath) ||
      /(?:-wal|-shm)$/.test(normalizedPath),
  },
  {
    reason: "environment files must never be bundled",
    test: (normalizedPath) => /(?:^|\/)\.env(?:\.|$)/.test(normalizedPath),
  },
  {
    reason: "runtime capability material must never be bundled",
    test: (normalizedPath) => {
      const basename = path.posix.basename(normalizedPath);
      const sourceFile = /\.(?:[cm]?js|jsx|tsx?|d\.ts|map|md)$/.test(basename);
      return (
        /\.(?:token|secret)$/.test(basename) ||
        (!sourceFile &&
          /^(?:capability|auth|semantic-answer|semantic-transcript)[-_.]?token(?:\.[^/]*)?$/.test(
            basename,
          ))
      );
    },
  },
];

function normalizeArtifactPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

function pathFindings(artifactPath) {
  const normalizedPath = normalizeArtifactPath(artifactPath);
  return FORBIDDEN_ARTIFACT_PATHS.filter(({ test }) => test(normalizedPath)).map(
    ({ reason }) => ({ artifact: artifactPath, reason }),
  );
}

function collectStrings(value, output) {
  if (typeof value === "string") {
    if (value.length >= 24) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, output);
  }
}

async function readCanaryFile(filePath) {
  const contents = await readFile(filePath, "utf8");
  try {
    const strings = [];
    collectStrings(JSON.parse(contents), strings);
    return strings;
  } catch {
    return contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length >= 8);
  }
}

function canariesFromEnvironment(environment) {
  const raw = environment.SEMANTIC_PRIVACY_CANARIES;
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(value)) {
      return value.filter((item) => typeof item === "string" && item.length >= 8);
    }
  } catch {
    // A newline-delimited value is more convenient in CI than JSON.
  }
  return raw
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.length >= 8);
}

function privateMarkers(options) {
  const environment = options.environment ?? process.env;
  const tokens = [
    ...(options.tokens ?? []),
    environment.SEMANTIC_ANSWER_TOKEN,
    environment.SEMANTIC_TRANSCRIPT_TOKEN,
    environment.SEMANTIC_ANSWER_CAPABILITY_TOKEN,
  ].filter((value) => typeof value === "string" && value.length >= 8);
  const values = [
    ...(options.canaries ?? []),
    ...canariesFromEnvironment(environment),
    ...tokens,
  ].filter((value) => typeof value === "string" && value.length >= 8);

  return [...new Set(values)].map((value) => ({
    bytes: Buffer.from(value),
    reason: tokens.includes(value)
      ? "configured capability token was embedded"
      : "configured private canary was embedded",
  }));
}

function contentFindings(artifactPath, contents, options, markers) {
  const findings = [];
  if (contents.subarray(0, 16).toString("binary") === "SQLite format 3\u0000") {
    findings.push({
      artifact: artifactPath,
      reason: "SQLite file signature was found in a deployable artifact",
    });
  }

  for (const marker of markers) {
    if (contents.indexOf(marker.bytes) !== -1) {
      findings.push({ artifact: artifactPath, reason: marker.reason });
    }
  }

  const workspaceRoot = path.resolve(
    options.workspaceRoot ?? options.projectRoot ?? defaultProjectRoot,
  );
  const workspaceForms = [
    workspaceRoot,
    workspaceRoot.replaceAll("\\", "/"),
    workspaceRoot.replaceAll("/", "\\"),
  ];
  const text = contents.toString("utf8").toLowerCase();
  if (workspaceForms.some((candidate) => text.includes(candidate.toLowerCase()))) {
    findings.push({
      artifact: artifactPath,
      reason: "an absolute workspace path was embedded",
    });
  }
  return findings;
}

async function collectDirectoryFiles(rootDirectory) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        files.push({
          absolutePath,
          relativePath: path.relative(rootDirectory, absolutePath),
          symbolicLink: true,
        });
      } else if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        files.push({
          absolutePath,
          relativePath: path.relative(rootDirectory, absolutePath),
          symbolicLink: false,
        });
      }
    }
  }
  await visit(rootDirectory);
  return files;
}

function tarString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  const boundedEnd = end === -1 || end > start + length ? start + length : end;
  return buffer.subarray(start, boundedEnd).toString("utf8");
}

function tarSize(buffer, start, length) {
  const value = tarString(buffer, start, length).trim().replaceAll("\u0000", "");
  return value ? Number.parseInt(value, 8) : 0;
}

function readTarEntries(archiveBuffer) {
  const tarBuffer =
    archiveBuffer[0] === 0x1f && archiveBuffer[1] === 0x8b
      ? gunzipSync(archiveBuffer)
      : archiveBuffer;
  const entries = [];
  let offset = 0;
  let pendingLongName;

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const size = tarSize(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || dataEnd > tarBuffer.length) {
      throw new Error("Malformed Sites tarball entry.");
    }
    const data = tarBuffer.subarray(dataStart, dataEnd);
    const conventionalName = prefix ? `${prefix}/${name}` : name;

    if (type === "L") {
      pendingLongName = data.toString("utf8").split("\u0000", 1)[0];
    } else if (type === "0" || type === "\u0000") {
      entries.push({ name: pendingLongName ?? conventionalName, contents: data });
      pendingLongName = undefined;
    } else {
      pendingLongName = undefined;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function unsafeArchivePath(entryName) {
  const normalized = entryName.replaceAll("\\", "/");
  return (
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split("/").includes("..")
  );
}

function trackedFileNames(projectRoot) {
  const output = execFileSync("git", ["-C", projectRoot, "ls-files", "-z"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.split("\u0000").filter(Boolean);
}

export async function scanBuildPrivacy(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? defaultProjectRoot);
  const distDirectory = path.resolve(options.distDirectory ?? path.join(projectRoot, "dist"));
  const markers = privateMarkers(options);
  const findings = [];
  let scannedFiles = 0;

  const distStat = await lstat(distDirectory).catch(() => null);
  if (!distStat?.isDirectory()) {
    throw new Error(`Build directory does not exist: ${distDirectory}`);
  }

  for (const file of await collectDirectoryFiles(distDirectory)) {
    const artifactName = `dist/${file.relativePath.replaceAll("\\", "/")}`;
    if (file.symbolicLink) {
      findings.push({ artifact: artifactName, reason: "symbolic links are not deployable" });
      continue;
    }
    scannedFiles += 1;
    const contents = await readFile(file.absolutePath);
    findings.push(...pathFindings(artifactName));
    findings.push(...contentFindings(artifactName, contents, options, markers));
  }

  for (const archivePath of options.archivePaths ?? []) {
    const archive = await readFile(path.resolve(archivePath));
    for (const entry of readTarEntries(archive)) {
      scannedFiles += 1;
      const artifactName = `archive:${entry.name}`;
      if (unsafeArchivePath(entry.name)) {
        findings.push({ artifact: artifactName, reason: "unsafe archive path" });
      }
      findings.push(...pathFindings(entry.name));
      findings.push(...contentFindings(artifactName, entry.contents, options, markers));
    }
  }

  if (options.checkGitTracked !== false) {
    for (const relativePath of trackedFileNames(projectRoot)) {
      const absolutePath = path.join(projectRoot, relativePath);
      const stat = await lstat(absolutePath).catch(() => null);
      // `git ls-files` includes index entries deleted in the current worktree.
      // A file that is not present cannot be bundled or leak runtime material.
      if (!stat?.isFile()) continue;
      findings.push(
        ...pathFindings(relativePath).map((finding) => ({
          ...finding,
          artifact: `git:${relativePath}`,
          reason: `tracked runtime/private artifact: ${finding.reason}`,
        })),
      );
      if (markers.length > 0) {
        const contents = await readFile(absolutePath);
        for (const marker of markers) {
          if (contents.indexOf(marker.bytes) !== -1) {
            findings.push({
              artifact: `git:${relativePath}`,
              reason: marker.reason,
            });
          }
        }
      }
    }
  }

  return { findings, scannedFiles };
}

export async function assertBuildPrivacy(options = {}) {
  const result = await scanBuildPrivacy(options);
  if (result.findings.length > 0) {
    const uniqueFindings = [
      ...new Map(
        result.findings.map((finding) => [
          `${finding.artifact}\u0000${finding.reason}`,
          finding,
        ]),
      ).values(),
    ];
    const details = uniqueFindings
      .map((finding) => `- ${finding.artifact}: ${finding.reason}`)
      .join("\n");
    throw new Error(`Build privacy check failed:\n${details}`);
  }
  return result;
}

function parseArguments(argv) {
  const options = {
    archivePaths: [],
    canaries: [],
    canaryFiles: [],
    tokens: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      if (!options.distDirectory) options.distDirectory = argument;
      else options.archivePaths.push(argument);
      continue;
    }
    const value = argv[index + 1];
    if (argument === "--skip-git") {
      options.checkGitTracked = false;
      continue;
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}.`);
    }
    index += 1;
    if (argument === "--dist") options.distDirectory = value;
    else if (argument === "--archive") options.archivePaths.push(value);
    else if (argument === "--canary") options.canaries.push(value);
    else if (argument === "--canary-file") options.canaryFiles.push(value);
    else if (argument === "--token") options.tokens.push(value);
    else if (argument === "--project-root") options.projectRoot = value;
    else if (argument === "--workspace-root") options.workspaceRoot = value;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  for (const filePath of options.canaryFiles) {
    options.canaries.push(...(await readCanaryFile(filePath)));
  }
  const result = await assertBuildPrivacy(options);
  process.stdout.write(`Build privacy check passed (${result.scannedFiles} files scanned).\n`);
}

const isMainModule =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
