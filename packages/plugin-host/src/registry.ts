import {
  isVersionedActionPlugin,
  validatePluginContract,
  type AnyActionPlugin,
  type HarnessPlugin,
  type PluginUse,
  type RelayPlugin,
  type SourcePlugin,
  type TriggerPlugin,
} from "@task-relay/plugin-sdk";

/**
 * Host-owned plugin registry. The SDK only defines public contracts; loading,
 * registration, aliases, and config parsing remain application-host concerns.
 */
export class RelayPluginRegistry {
  private readonly revisions = new Map<string, string>();
  private readonly sources = new Map<PluginUse, SourcePlugin>();
  private readonly triggers = new Map<PluginUse, TriggerPlugin>();
  private readonly actions = new Map<PluginUse, AnyActionPlugin>();
  private readonly harnesses = new Map<PluginUse, HarnessPlugin>();

  setRevision(use: string, revision: string): this { this.revisions.set(use, revision); return this; }
  revision(use: string): string { return this.revisions.get(use) ?? "built-in:1"; }

  register(plugin: RelayPlugin, alias: PluginUse = plugin.use): this {
    validatePluginContract(plugin);
    const collection = plugin.kind === "source" ? this.sources : plugin.kind === "trigger" ? this.triggers : plugin.kind === "action" ? this.actions : this.harnesses;
    if (collection.has(alias)) throw new Error(`A ${plugin.kind} plugin named '${alias}' is already registered.`);
    collection.set(alias, plugin as never);
    return this;
  }

  registerSource(plugin: SourcePlugin): this { return this.register(plugin); }
  registerTrigger(plugin: TriggerPlugin): this { return this.register(plugin); }
  registerAction(plugin: AnyActionPlugin): this { return this.register(plugin); }
  registerHarness(plugin: HarnessPlugin): this { return this.register(plugin); }
  registerAs(alias: PluginUse, plugin: RelayPlugin): this { return this.register(plugin, alias); }
  source(use: PluginUse): SourcePlugin | undefined { return this.sources.get(use); }
  trigger(use: PluginUse): TriggerPlugin | undefined { return this.triggers.get(use); }
  action(use: PluginUse): AnyActionPlugin | undefined { return this.actions.get(use); }
  harness(use: PluginUse): HarnessPlugin | undefined { return this.harnesses.get(use); }

  parseSourceConfig(use: PluginUse, value: unknown): unknown { const plugin = this.source(use); if (!plugin) throw new Error(`Unknown source plugin '${use}'.`); return plugin.configSchema.parse(value); }
  parseSourceMatch(use: PluginUse, value: unknown): unknown { const plugin = this.source(use); if (!plugin) throw new Error(`Unknown source plugin '${use}'.`); return plugin.matchSchema.parse(value); }
  parseTriggerConfig(use: PluginUse, value: unknown): unknown { const plugin = this.trigger(use); if (!plugin) throw new Error(`Unknown trigger plugin '${use}'.`); return plugin.configSchema.parse(value); }
  parseActionConfig(use: PluginUse, value: unknown): unknown { const plugin = this.action(use); if (!plugin) throw new Error(`Unknown action plugin '${use}'.`); return isVersionedActionPlugin(plugin) ? plugin.inputSchema.parse(value) : plugin.configSchema.parse(value); }
  parseActionOutput(use: PluginUse, value: unknown): unknown { const plugin = this.action(use); if (!plugin) throw new Error(`Unknown action plugin '${use}'.`); return isVersionedActionPlugin(plugin) && plugin.outputSchema ? plugin.outputSchema.parse(value) : value; }
  parseHarnessConfig(use: PluginUse, value: unknown): unknown { const plugin = this.harness(use); if (!plugin) throw new Error(`Unknown harness plugin '${use}'.`); return plugin.configSchema.parse(value); }
  list(): readonly RelayPlugin[] { return [...this.sources.values(), ...this.triggers.values(), ...this.actions.values(), ...this.harnesses.values()]; }
}
