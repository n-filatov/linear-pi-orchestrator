import { createRelayProgram } from "./program.js";
import { createRuntimeHandlers } from "../app.js";

const program = createRelayProgram({ handlers: createRuntimeHandlers() });
program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
