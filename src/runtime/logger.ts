import type { Attributes } from "../model/primitives.js";
import { LOG_LEVEL_RANK, type Logger, type LogLevel } from "./ports.js";

export const createNullLogger = (): Logger => ({
  error: (): void => undefined,
  warn: (): void => undefined,
  info: (): void => undefined,
  debug: (): void => undefined,
});

export type StderrLoggerOptions = {
  readonly level?: LogLevel;
  /** Injected for tests; defaults to `process.stderr.write`. */
  readonly write?: (line: string) => void;
};

/**
 * Diagnostic logger that writes to stderr only.
 *
 * stdout belongs to the host agent's hook protocol: anything written there can
 * be parsed as a hook response and change the agent's behaviour (ADR 0004).
 */
export const createStderrLogger = (options: StderrLoggerOptions = {}): Logger => {
  const level = options.level ?? "warn";
  const write =
    options.write ??
    ((line: string): void => {
      process.stderr.write(line);
    });
  const threshold = LOG_LEVEL_RANK[level];

  const log = (entryLevel: LogLevel, message: string, fields?: Attributes): void => {
    if (LOG_LEVEL_RANK[entryLevel] > threshold || threshold === 0) {
      return;
    }
    const payload =
      fields === undefined || Object.keys(fields).length === 0
        ? { level: entryLevel, message }
        : { level: entryLevel, message, fields };
    write(`${JSON.stringify(payload)}\n`);
  };

  return {
    error: (message: string, fields?: Attributes): void => {
      log("error", message, fields);
    },
    warn: (message: string, fields?: Attributes): void => {
      log("warn", message, fields);
    },
    info: (message: string, fields?: Attributes): void => {
      log("info", message, fields);
    },
    debug: (message: string, fields?: Attributes): void => {
      log("debug", message, fields);
    },
  };
};
