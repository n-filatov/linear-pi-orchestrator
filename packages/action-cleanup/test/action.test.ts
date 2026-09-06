import { describe, expect, it } from "vitest";
import { cleanupConfigSchema } from "../src/index.js";
describe("cleanup action", () => it("defaults to stopping an active worker", () => expect(cleanupConfigSchema.parse({})).toEqual({ activeWorker: "stop", ownedTmuxOnly: false })));
