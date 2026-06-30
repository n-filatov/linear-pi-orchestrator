import type { UIProvider } from "./ui.js";

const LEVEL_PREFIX: Record<string, string> = {
  info: "",
  warning: "Warning: ",
  error: "Error: ",
};

export class CliUIProvider implements UIProvider {
  notify(message: string, level: "info" | "warning" | "error" = "info") {
    const stream = level === "error" ? process.stderr : process.stdout;
    const prefix = LEVEL_PREFIX[level] ?? "";
    stream.write(`${prefix}${message}\n`);
  }

  async select(prompt: string, choices: string[]): Promise<string | undefined> {
    const { select } = await import("@inquirer/prompts");
    return select({
      message: prompt,
      choices: choices.map((c) => ({ name: c, value: c })),
    }).catch(() => undefined);
  }

  async confirm(title: string, detail: string): Promise<boolean> {
    const { confirm } = await import("@inquirer/prompts");
    if (detail) this.notify(detail, "info");
    return confirm({ message: title, default: false }).catch(() => false);
  }

  /** No-op — CLI has no footer status bar. */
  setStatus(_key: string, _text: string | undefined) {}

  /** No-op — CLI has no widget panel. */
  setWidget(_key: string, _lines: string[]) {}
}
