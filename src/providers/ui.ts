export interface UIProvider {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  select(prompt: string, choices: string[]): Promise<string | undefined>;
  confirm(title: string, detail: string): Promise<boolean>;
  /** Update a footer status item. Pass undefined to clear it. No-op in CLI. */
  setStatus(key: string, text: string | undefined): void;
  /** Update a widget panel. No-op in CLI. */
  setWidget(key: string, lines: string[]): void;
}
