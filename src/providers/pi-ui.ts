import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UIProvider } from "./ui.ts";

export class PiUIProvider implements UIProvider {
  private ctx: ExtensionContext | undefined;

  setContext(ctx: ExtensionContext | undefined) {
    this.ctx = ctx;
  }

  notify(message: string, level: "info" | "warning" | "error" = "info") {
    this.ctx?.ui?.notify?.(message, level);
  }

  /** No-op — the Pi host renders watcher progress via the status widget. */
  logLine(_scope: string, _message: string, _level: "info" | "warning" | "error" = "info") {}

  async select(prompt: string, choices: string[]): Promise<string | undefined> {
    if (!this.ctx) return undefined;
    return this.ctx.ui.select(prompt, choices);
  }

  async confirm(title: string, detail: string): Promise<boolean> {
    if (!this.ctx) return false;
    return this.ctx.ui.confirm(title, detail);
  }

  setStatus(key: string, text: string | undefined) {
    this.ctx?.ui?.setStatus?.(key, text);
  }

  setWidget(key: string, lines: string[]) {
    this.ctx?.ui?.setWidget?.(key, lines);
  }
}
