import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { VIEWER_SUCCESS_FINAL } from "../../server/final-surface-policy.mjs";

const skillPath = path.resolve("semantic-answer-final", "SKILL.md");
const skill = readFileSync(skillPath, "utf8");
const lines = skill.split(/\r?\n/).length;

test("runtime Semantic Answer skill stays concise and preserves the linear-answer contract", () => {
  assert.ok(lines >= 45 && lines <= 90, `runtime skill should stay concise; got ${lines} lines`);
  assert.match(skill, /body[^.]*concise, complete Markdown answer/i);
  assert.match(skill, /directly answer the user without expansions/i);
  assert.match(skill, /decision-changing caveat[^.]*visible in the body/i);
  assert.match(skill, /\[visible text\]\(zoom:id\)/i);
  assert.match(skill, /kind: "definition"[^.]*brief contextual meaning[^.]*popover/i);
  assert.match(skill, /kind: "detail"[^.]*detail rail or sheet/i);
  assert.match(skill, /do not place `zoom:` links inside expansion content/i);
  assert.match(skill, /a simple answer may have no expansions/i);
  assert.match(
    skill,
    /requestSummary[^.]*one or two concise sentences[\s\S]*summarize the request, not the answer/i,
  );
  assert.match(skill, /read at most one complete prior turn/i);
  assert.match(skill, /opening it never calls the model/i);
  assert.match(skill, /repair only the reported issue and retry once/i);
  assert.match(
    skill,
    /one-off side chat[\s\S]*isolated `Temporary` session[\s\S]*never guess or reuse the main task/i,
  );
  assert.match(
    skill,
    /after confirmed success, emit only:[\s\S]*Rendered in Semantic Answer\./i,
  );
  assert.equal(skill.includes(VIEWER_SUCCESS_FINAL), true, "success status must not drift");
  assert.match(
    skill,
    /publication is not confirmed[^.]*give the complete answer normally[^.]*do not claim success/i,
  );
  assert.doesNotMatch(skill, /root|children|terms|term:|tree|density|expand all|collapse all/i);
  assert.doesNotMatch(
    skill,
    /PublicationEnvelope|Bearer token|POST \/api\/publish|same idempotency key/i,
    "the runtime skill must not carry the deterministic transport protocol",
  );
});
