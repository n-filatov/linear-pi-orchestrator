import { CodexAppServerClient, type CodexModel } from "./app-server-client.js";

/** Read the model picker from the installed/authenticated Codex CLI. */
export async function listCodexModels(cwd: string, timeoutMs = 3_000): Promise<CodexModel[]> {
  const client = await CodexAppServerClient.start({
    cwd,
    initialize: { clientInfo: { name: "task_relay", title: "Task Relay", version: "0.1.0" } },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      client.listModels({ includeHidden: false, limit: 100 }).then((result) => result.data.filter((model) => !model.hidden)),
      new Promise<CodexModel[]>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out while loading Codex models.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await client.stop({ timeoutMs: 500, forceKillTimeoutMs: 100 }).catch(() => undefined);
  }
}
