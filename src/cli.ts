#!/usr/bin/env node

import { runCli } from "./cli/main.js";

/**
 * Thin process wrapper.
 *
 * All behaviour lives in `runCli`, which is handed its argv, environment, and
 * streams; this file is the only place that touches `process` at all, and it
 * never writes to `process.env`.
 */
const flushStream = (stream: NodeJS.WriteStream): Promise<void> =>
  // Unconditional: the callback fires once everything queued before it has been
  // handed to the OS. Checking `writableLength` first is not equivalent — a
  // pipe's queue can read as empty while bytes are still in flight, and a
  // truncated hook response would corrupt the host agent's protocol.
  new Promise<void>((resolve) => {
    stream.write("", () => resolve());
  });

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  let code: number;
  try {
    code = await runCli({
      argv,
      env: process.env,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
  } catch (thrown) {
    // Unreachable by contract; still contained, because an unhandled rejection
    // here would surface to the host agent as a crashed hook.
    process.stderr.write(
      `otel-hook: unexpected failure (${thrown instanceof Error ? thrown.name : typeof thrown})\n`,
    );
    code = 0;
  }

  await flushStream(process.stdout);
  await flushStream(process.stderr);

  if (argv[0] === "run") {
    // A bounded flush may have given up on a collector that is still holding a
    // socket open. Waiting for the event loop to drain would make the host agent
    // pay for that, so the hook path exits explicitly once its streams are out.
    process.exit(code);
  }
  // The diagnostic commands are ordinary programs: let Node exit naturally so
  // nothing they wrote can be cut short.
  process.exitCode = code;
};

await main();
