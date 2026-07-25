/**
 * Deterministic pseudo-random generator for property-style tests.
 *
 * Hand-rolled rather than pulled from a dependency so the seed, and therefore
 * every reported counterexample, is reproducible from the test source alone.
 */
export interface SeededRandom {
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(values: readonly T[]): T;
  bool(): boolean;
  string(maxLength: number): string;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789 _-./:@";

export const createSeededRandom = (seed: number): SeededRandom => {
  let state = (seed >>> 0) || 1;
  const next = (): number => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };

  const int = (minInclusive: number, maxInclusive: number): number =>
    minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1));

  return {
    int,
    pick: <T>(values: readonly T[]): T => {
      const index = int(0, values.length - 1);
      const value = values[index];
      if (value === undefined) {
        throw new Error("pick from empty array");
      }
      return value;
    },
    bool: (): boolean => next() < 0.5,
    string: (maxLength: number): string => {
      const length = int(0, maxLength);
      let result = "";
      for (let index = 0; index < length; index += 1) {
        result += ALPHABET[int(0, ALPHABET.length - 1)] ?? "a";
      }
      return result;
    },
  };
};
