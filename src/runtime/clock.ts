import { epochMillisSchema, type EpochMillis } from "../model/primitives.js";
import type { Clock } from "./ports.js";

/** Clock backed by the host process. */
export const createSystemClock = (): Clock => ({
  now: (): EpochMillis => epochMillisSchema.parse(Date.now()),
  monotonicMillis: (): number => Number(process.hrtime.bigint() / 1_000_000n),
});

export type FixedClockOptions = {
  readonly startMillis?: number;
  /** Milliseconds added to the wall clock on each `now()` call. */
  readonly tickMillis?: number;
};

/**
 * Deterministic clock for tests.
 *
 * `advance` moves both readings together so duration arithmetic stays coherent.
 */
export interface FixedClock extends Clock {
  advance(millis: number): void;
  set(millis: number): void;
}

export const createFixedClock = (options: FixedClockOptions = {}): FixedClock => {
  let wall = options.startMillis ?? 1_700_000_000_000;
  let monotonic = 0;
  const tick = options.tickMillis ?? 0;

  return {
    now: (): EpochMillis => {
      const current = wall;
      wall += tick;
      monotonic += tick;
      return epochMillisSchema.parse(current);
    },
    monotonicMillis: (): number => monotonic,
    advance: (millis: number): void => {
      wall += millis;
      monotonic += millis;
    },
    set: (millis: number): void => {
      wall = millis;
    },
  };
};
