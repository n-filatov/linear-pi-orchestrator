export interface UIProvider {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  /**
   * Emit a scoped watcher log line to the interactive console. Separate from
   * the durable file log and the Pi widget — this is only the human-attended
   * pretty console. No-op when there is no interactive terminal (Pi host).
   */
  logLine(scope: string, message: string, level?: "info" | "warning" | "error"): void;
  select(prompt: string, choices: string[]): Promise<string | undefined>;
  confirm(title: string, detail: string): Promise<boolean>;
  /** Update a footer status item. Pass undefined to clear it. No-op in CLI. */
  setStatus(key: string, text: string | undefined): void;
  /** Update a widget panel. No-op in CLI. */
  setWidget(key: string, lines: string[]): void;
}
