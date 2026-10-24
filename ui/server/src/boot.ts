// Entry point: node server/dist/boot.js, through the ui and ui-check scripts only.
// hardenEnv runs before main.js is imported, so every ANTHROPIC_* variable is gone before the
// SDK module is evaluated (static imports would be evaluated first; this one is dynamic).
import { hardenEnv, installErrorHandlers } from "./harden.js";

try {
  hardenEnv({ env: process.env, execArgv: process.execArgv });
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
}
installErrorHandlers(process);

const { run } = await import("./main.js");
process.exitCode = await run(process.argv.slice(2));
