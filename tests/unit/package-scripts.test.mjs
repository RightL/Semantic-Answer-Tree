import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJsonUrl = new URL("../../package.json", import.meta.url);

test("the production viewer starts on the loopback interface", async () => {
  const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8"));

  assert.equal(
    packageJson.scripts.start,
    "vinext start --hostname 127.0.0.1 --port 4173",
  );
});
