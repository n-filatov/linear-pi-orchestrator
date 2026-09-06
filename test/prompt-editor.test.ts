import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getEditablePrompt, saveEditablePrompt } from "../src/prompts/editor.js";

const roots: string[] = [];
async function root() { const value = await mkdtemp(join(tmpdir(), "relay-prompt-test-")); roots.push(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
describe("repository prompt editing", () => {
  it("creates files, reads revisions, and saves existing prompts", async () => {
    const dir = await root(); const path = ".task-relay/prompts/review.md";
    const created = await saveEditablePrompt(dir, path, "# Review", null);
    expect(await getEditablePrompt(dir, path)).toEqual(created);
    const saved = await saveEditablePrompt(dir, path, "# Updated", created.revision);
    expect(saved.revision).not.toBe(created.revision);
    expect(await readFile(join(dir, path), "utf8")).toBe("# Updated");
    await expect(saveEditablePrompt(dir, path, "overwrite", null)).rejects.toMatchObject({ status: 409 });
  });
  it("preserves external changes and rejects concurrent stale saves", async () => {
    const dir = await root(); const path = ".task-relay/prompts/review.md";
    const created = await saveEditablePrompt(dir, path, "original", null);
    const results = await Promise.allSettled([saveEditablePrompt(dir, path, "first", created.revision), saveEditablePrompt(dir, path, "second", created.revision)]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    await writeFile(join(dir, path), "external");
    await expect(saveEditablePrompt(dir, path, "stale", created.revision)).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(dir, path), "utf8")).toBe("external");
  });
  it("rejects traversal, unsupported files, and symlink escapes", async () => {
    const dir = await root(); const outside = await root();
    for (const path of ["/tmp/prompt.md", ".task-relay/prompts/../../escape.md", ".task-relay/prompts/code.js", ".task-relay/prompts/../secret.txt"])
      await expect(saveEditablePrompt(dir, path, "bad", null)).rejects.toMatchObject({ status: 400 });
    await mkdir(join(dir, ".task-relay"));
    await symlink(outside, join(dir, ".task-relay/prompts"));
    await expect(saveEditablePrompt(dir, ".task-relay/prompts/escape.md", "bad", null)).rejects.toMatchObject({ status: 400 });
    await expect(getEditablePrompt(dir, ".task-relay/prompts/escape.md")).rejects.toMatchObject({ status: 400 });
  });
});
