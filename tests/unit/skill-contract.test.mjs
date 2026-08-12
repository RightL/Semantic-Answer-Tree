import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { VIEWER_SUCCESS_FINAL } from "../../server/final-surface-policy.mjs";

const skillPath = path.resolve("semantic-zoom-final", "SKILL.md");
const skill = readFileSync(skillPath, "utf8");
const lines = skill.split(/\r?\n/).length;

test("runtime semantic-answer skill stays concise and preserves its six core promises", () => {
  assert.ok(lines >= 70 && lines <= 110, `runtime skill should stay near 70-100 lines; got ${lines}`);

  assert.match(
    skill,
    /root must directly answer the main question without expansion/i,
    "the root must remain independently useful",
  );
  assert.match(
    skill,
    /accurate compression of its entire subtree/i,
    "recursive semantic compression must remain explicit",
  );
  assert.match(
    skill,
    /what does this phrase mean here/i,
    "term definitions must remain contextual",
  );
  assert.match(
    skill,
    /lexical zoom may appear[\s\S]*any node[\s\S]*any structural depth/i,
    "lexical zoom must remain available at every tree level",
  );
  assert.match(
    skill,
    /requestSummary[\s\S]*one or two concise sentences[\s\S]*summarize the request, not the answer/i,
    "request summaries must remain concise and request-focused",
  );
  assert.match(
    skill,
    /after confirmed success, emit only:[\s\S]*Rendered in Semantic Answer Tree\./i,
    "confirmed success must have exactly one viewer answer surface",
  );
  assert.equal(skill.includes(VIEWER_SUCCESS_FINAL), true, "success status must not drift");
  assert.match(
    skill,
    /publication is not confirmed, return the[\s\S]*complete answer normally/i,
    "unconfirmed publication must fall back to an ordinary final answer",
  );
  assert.match(
    skill,
    /one-off side chat[\s\S]*isolated temporary session[\s\S]*never guess or reuse the main/i,
    "identity-less side chats must use isolated temporary publication without impersonating the main task",
  );
  assert.doesNotMatch(
    skill,
    /PublicationEnvelope|Bearer token|POST \/api\/publish|durable success only when|same idempotency key/i,
    "runtime skill must not carry the deterministic transport protocol",
  );
});
