import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from "node:fs";
import path from "node:path";

export const SEMANTIC_ANSWER_TOKEN_ENV = "SEMANTIC_ANSWER_TOKEN";
export const SEMANTIC_ANSWER_TOKEN_FILE_ENV = "SEMANTIC_ANSWER_TOKEN_FILE";

export function resolveTokenFilePath(dbPath, environment = process.env) {
  const configured = environment[SEMANTIC_ANSWER_TOKEN_FILE_ENV];
  return path.resolve(configured || path.join(path.dirname(dbPath), "capability-token"));
}

export function validateCapabilityToken(token) {
  if (typeof token !== "string" || !/^\S{32,}$/u.test(token)) {
    throw new Error(`${SEMANTIC_ANSWER_TOKEN_ENV} must match ^\\S{32,}$ (32 or more characters with no whitespace).`);
  }
  return token;
}

export function loadOrCreateCapabilityToken(options = {}) {
  const environment = options.environment ?? process.env;
  if (options.token !== undefined || environment[SEMANTIC_ANSWER_TOKEN_ENV]) {
    return {
      token: validateCapabilityToken(options.token ?? environment[SEMANTIC_ANSWER_TOKEN_ENV]),
      tokenFilePath: null,
      created: false,
    };
  }

  const tokenFilePath = path.resolve(
    options.tokenFilePath ?? resolveTokenFilePath(options.dbPath, environment),
  );
  mkdirSync(path.dirname(tokenFilePath), { recursive: true });
  try {
    const token = validateCapabilityToken(readFileSync(tokenFilePath, "utf8").trim());
    try {
      chmodSync(tokenFilePath, 0o600);
    } catch {
      // Windows may not expose POSIX modes; the file remains local to the user profile.
    }
    return { token, tokenFilePath, created: false };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const token = randomBytes(32).toString("hex");
  let descriptor;
  try {
    descriptor = openSync(tokenFilePath, "wx", 0o600);
    writeFileSync(descriptor, `${token}\n`, "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    return { token, tokenFilePath, created: true };
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (error?.code === "EEXIST") {
      return {
        token: validateCapabilityToken(readFileSync(tokenFilePath, "utf8").trim()),
        tokenFilePath,
        created: false,
      };
    }
    throw error;
  }
}

/** Constant-time comparison using fixed-length digests, including on length mismatch. */
export function capabilityTokenMatches(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") {
    return false;
  }
  const candidateDigest = createHash("sha256").update(candidate).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

export function bearerToken(authorization) {
  if (typeof authorization !== "string") {
    return null;
  }
  const match = authorization.match(/^Bearer ([^\s]+)$/);
  return match?.[1] ?? null;
}
