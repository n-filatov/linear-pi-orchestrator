import type { DynamicModule, OnApplicationShutdown, Provider } from "@nestjs/common";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { TaskRelay, type StopOptions, type TaskRelayDependencies } from "../core/task-relay.js";

/** Explicit injection token for the dependency bundle owned by the composition root. */
export const TASK_RELAY_DEPENDENCIES = Symbol("TASK_RELAY_DEPENDENCIES");
/** Explicit lifecycle provider token, useful when inspecting a Nest application context. */
export const TASK_RELAY_LIFECYCLE = Symbol("TASK_RELAY_LIFECYCLE");

export interface RelayModuleOptions {
  /** Passed to TaskRelay.stop when the Nest application context closes. */
  stop?: StopOptions;
}

class RelayShutdown implements OnApplicationShutdown {
  public constructor(
    private readonly relay: TaskRelay,
    private readonly options: StopOptions,
  ) {}

  public onApplicationShutdown(): Promise<void> {
    return this.relay.stop(this.options);
  }
}

/**
 * Nest composition boundary for Relay.
 *
 * The module is intentionally returned dynamically: all dependencies are
 * supplied by the caller through a typed factory and no reflected constructor
 * metadata or decorator-based dependency discovery is required.
 */
export class RelayModule {
  public static register(
    dependencies: TaskRelayDependencies,
    options: RelayModuleOptions = {},
  ): DynamicModule {
    const dependencyProvider: Provider = {
      provide: TASK_RELAY_DEPENDENCIES,
      useFactory: (): TaskRelayDependencies => dependencies,
    };
    const relayProvider: Provider = {
      provide: TaskRelay,
      useFactory: (resolved: TaskRelayDependencies): TaskRelay => new TaskRelay(resolved),
      inject: [TASK_RELAY_DEPENDENCIES],
    };
    const lifecycleProvider: Provider = {
      provide: TASK_RELAY_LIFECYCLE,
      useFactory: (relay: TaskRelay): RelayShutdown => new RelayShutdown(relay, options.stop ?? {}),
      inject: [TaskRelay],
    };
    return {
      module: RelayModule,
      providers: [dependencyProvider, relayProvider, lifecycleProvider],
      exports: [TaskRelay, TASK_RELAY_DEPENDENCIES],
    };
  }
}

export async function createRelayApplication(dependencies: TaskRelayDependencies): Promise<{ relay: TaskRelay; close(): Promise<void> }> {
  const application = await NestFactory.createApplicationContext(RelayModule.register(dependencies), { logger: false, abortOnError: false });
  let closing: Promise<void> | undefined;
  return {
    relay: application.get(TaskRelay),
    close: () => closing ??= application.close(),
  };
}
