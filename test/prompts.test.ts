import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listPromptFiles, readPromptFile } from "../src/prompts/library.js";

describe("prompt library", () => {
  it("lists Markdown and text prompts from the repository-owned default folder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "relay-prompts-"));
    const prompts = path.join(root, ".task-relay/prompts/review");
    await mkdir(prompts, { recursive: true });
    await writeFile(path.join(prompts, "security.md"), "Review {{item.id}}", "utf8");
    await writeFile(path.join(prompts, "notes.txt"), "Notes", "utf8");
    await writeFile(path.join(prompts, "ignored.json"), "{}", "utf8");

    expect(await listPromptFiles(root)).toEqual([
      ".task-relay/prompts/review/notes.txt",
      ".task-relay/prompts/review/security.md",
    ]);
    await expect(readPromptFile(root, ".task-relay/prompts/review/security.md")).resolves.toBe("Review {{item.id}}");
  });
});
