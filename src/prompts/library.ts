import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Repository-owned prompt library. Paths returned from here are YAML-safe. */
export const PROMPTS_DIRECTORY = ".task-relay/prompts";
const PROMPT_EXTENSIONS = new Set([".md", ".txt"]);

export async function listPromptFiles(repositoryRoot: string): Promise<string[]> {
  const root = path.resolve(repositoryRoot, PROMPTS_DIRECTORY);
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return visit(fullPath);
      if (entry.isFile() && PROMPT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(path.relative(repositoryRoot, fullPath));
      }
    }));
  }
  await visit(root);
  return files.sort();
}

export async function readPromptFile(repositoryRoot: string, promptFile: string): Promise<string> {
  const resolved = path.isAbsolute(promptFile) ? promptFile : path.resolve(repositoryRoot, promptFile);
  return readFile(resolved, "utf8");
}
