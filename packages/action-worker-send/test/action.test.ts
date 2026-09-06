import { describe, expect, it } from "vitest";
import { workerSendConfigSchema } from "../src/index.js";
import { createWorkerSendAction } from "../src/index.js";
describe("worker send action", () => it("requires text and submits by default", () => {
  expect(workerSendConfigSchema.parse({ text: "status" })).toMatchObject({ submit: true });
  expect(() => workerSendConfigSchema.parse({})).toThrow();
}));

it("does not template centrally resolved text a second time", async () => {
  let received = "";
  const context = { inputsResolved: true, item: {}, outputs: {}, repository: {}, workers: { send: async (_ref: unknown, input: { text: string }) => { received = input.text; return { status: "succeeded" }; } } } as any;
  await createWorkerSendAction().execute(context, workerSendConfigSchema.parse({ text: "${{ needs.a.outputs.text }}" }));
  expect(received).toBe("${{ needs.a.outputs.text }}");
});
