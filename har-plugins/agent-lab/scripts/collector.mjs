import { startOtlpReceiver } from "../../../scripts/e2e-proof/otlp-receiver.mjs";

/**
 * Local OTLP HTTP collector for the agent lab.
 *
 * A thin view over the e2e proof receiver (scripts/e2e-proof/otlp-receiver.mjs):
 * raw bodies stay in memory so privacy assertions can search the bytes that left
 * otel-hook, and, when `captureDir` is given, every request is also written to
 * disk in the format `scripts/e2e-proof/check-evidence.mjs` reads.
 */
export const startLabCollector = async (options = {}) => {
  const receiver = await startOtlpReceiver({ captureDir: options.captureDir });
  return {
    tracesUrl: receiver.tracesUrl,
    logsUrl: receiver.logsUrl,
    captureDir: receiver.captureDir,
    requests: receiver.requests,
    bodiesFor: receiver.bodiesFor,
    latin1: receiver.latin1,
    close: receiver.close,
  };
};
