import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { RelayModule } from "../src/application/relay-module.js";
import { TaskRelay, type TaskRelayDependencies } from "../src/core/task-relay.js";

function dependencies(close: () => Promise<void>): TaskRelayDependencies {
  return {
    triggers: { list: async () => [] },
    sources: [{ id: "fixture", discover: async () => [], report: async () => {}, close }],
    runStore: {} as TaskRelayDependencies["runStore"],
    workspaceProvider: {} as TaskRelayDependencies["workspaceProvider"],
    agentLauncher: {} as TaskRelayDependencies["agentLauncher"],
    logger: {} as TaskRelayDependencies["logger"],
  };
}

describe("RelayModule", () => {
  it("composes arbitrary dependencies and stops the relay when the context closes", async () => {
    const close = vi.fn(async () => {});
    const app = await NestFactory.createApplicationContext(RelayModule.register(dependencies(close)), { logger: false });
    expect(app.get(TaskRelay)).toBeInstanceOf(TaskRelay);
    await app.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
