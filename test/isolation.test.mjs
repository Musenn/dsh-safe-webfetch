import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("runtime has no external service, filesystem, credential, conversation, or git integration", async () => {
  const source = (await Promise.all((await readdir(join(root, "lib"))).filter((file) => file.endsWith(".js")).map((file) => readFile(join(root, "lib", file), "utf8")))).join("\n").toLowerCase();
  for (const forbidden of [
    "api.firecrawl",
    "r.jina.ai",
    "tavily",
    "child_process",
    "node:fs",
    "process.env",
    ".credentials",
    "conversation",
    "sessions/",
    "git push",
    "git remote",
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden runtime integration: ${forbidden}`);
  }
});
