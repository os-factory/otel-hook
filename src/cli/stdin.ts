import type { Readable } from "node:stream";

/**
 * Bounded stdin reader.
 *
 * A hook is invoked with one payload on stdin. Reading it without a bound would
 * let a misbehaving host (or a redirected file) grow this process's memory
 * without limit, so the read aborts as soon as the accumulated length exceeds
 * the configured cap rather than after buffering everything.
 *
 * "Exactly one value" is enforced by `JSON.parse`: it rejects trailing content,
 * so a concatenated stream of payloads (`{...}{...}`) is an error rather than a
 * silently truncated first object.
 */
export type StdinDecodeResult =
  | { readonly status: "ok"; readonly value: unknown; readonly byteLength: number }
  | {
      readonly status: "error";
      readonly code: "empty-input" | "input-too-large" | "not-json" | "read-failed";
      readonly detail: string;
      readonly byteLength?: number;
    };

export const readBoundedJson = async (
  stream: Readable,
  maxBytes: number,
): Promise<StdinDecodeResult> => {
  const chunks: Buffer[] = [];
  let byteLength = 0;

  try {
    for await (const chunk of stream) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
      byteLength += buffer.byteLength;
      if (byteLength > maxBytes) {
        // Stop consuming immediately; the payload is already unusable and
        // draining the rest only costs memory.
        stream.destroy();
        return {
          status: "error",
          code: "input-too-large",
          detail: `stdin exceeded the ${String(maxBytes)}-byte bound`,
          byteLength,
        };
      }
      chunks.push(buffer);
    }
  } catch (thrown) {
    return {
      status: "error",
      code: "read-failed",
      // Only the error's constructor name crosses this boundary: a stream error
      // message can contain a path.
      detail: thrown instanceof Error ? `stdin read failed (${thrown.name})` : "stdin read failed",
      byteLength,
    };
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) {
    return { status: "error", code: "empty-input", detail: "stdin was empty", byteLength };
  }

  try {
    return { status: "ok", value: JSON.parse(text) as unknown, byteLength };
  } catch {
    // The parser's message quotes the offending input, which may be a prompt.
    return {
      status: "error",
      code: "not-json",
      detail: "stdin was not a single well-formed JSON value",
      byteLength,
    };
  }
};
