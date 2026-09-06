import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";
import { PROMPTS_DIRECTORY } from "./library.js";

export class PromptEditorError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const revision = (content: string) => createHash("sha256").update(content).digest("hex");

async function target(root: string, file: string) {
  if (!file.startsWith(`${PROMPTS_DIRECTORY}/`) || file.includes("\\") || file.split("/").some((part) => !part || part === "." || part === "..") || !/\.(md|txt)$/i.test(file))
    throw new PromptEditorError("Choose a .md or .txt file inside .task-relay/prompts.", 400);
  const base = await realpath(root);
  let current = base;
  for (const part of file.split("/")) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new PromptEditorError("Symbolic links cannot be edited in the prompt library.", 400);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return current;
}

export async function getEditablePrompt(root: string, file: string) {
  const location = await target(root, file);
  try {
    const content = await readFile(location, "utf8");
    return { path: file, content, revision: revision(content) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PromptEditorError("Prompt not found.", 404);
    throw error;
  }
}

// Serialize dashboard writes so two editors cannot both overwrite one revision.
const pending = new Map<string, Promise<unknown>>();
export async function saveEditablePrompt(root: string, file: string, content: string, expected: string | null) {
  const location = await target(root, file);
  const previous = pending.get(location) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    await target(root, file);
    await mkdir(path.dirname(location), { recursive: true });
    if (expected === null) {
      try { await writeFile(location, content, { encoding: "utf8", flag: "wx" }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PromptEditorError("A prompt with this name already exists.", 409);
        throw error;
      }
    } else {
      const current = await getEditablePrompt(root, file);
      if (current.revision !== expected) throw new PromptEditorError("This prompt changed on disk. Reopen it before saving your changes.", 409);
      await writeFileAtomic(location, content);
    }
    return { path: file, content, revision: revision(content) };
  });
  pending.set(location, operation);
  try { return await operation; }
  finally { if (pending.get(location) === operation) pending.delete(location); }
}
