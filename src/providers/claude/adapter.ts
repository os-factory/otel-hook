import { SILENT_HOOK_RESPONSE, type ProviderAdapter, type ProviderHookResponse } from "../adapter.js";
import { CLAUDE_CODE_CAPABILITIES } from "./capabilities.js";
import { CLAUDE_DELIVERY_GAPS, claudeDeliveryIdentity } from "./delivery.js";
import { CLAUDE_CODE_PROVIDER_ID, detectClaudeCode } from "./detect.js";
import { parseClaudeCode } from "./events.js";
import { identifyClaudeCode } from "./identity.js";

export type ClaudeCodeAdapterOptions = {
  /** Adapter version reported in provenance; defaults to `1.0.0`. */
  readonly version?: string;
};

/**
 * Provider adapter for Claude Code's hook protocol.
 *
 * Always answers hook invocations silently: this adapter is a telemetry
 * sidecar, not the hook that governs permissions or turn continuation, and
 * must never be able to block the host agent (ADR 0004).
 */
export const createClaudeCodeAdapter = (options: ClaudeCodeAdapterOptions = {}): ProviderAdapter => ({
  id: CLAUDE_CODE_PROVIDER_ID,
  version: options.version ?? "1.0.0",
  capabilities: CLAUDE_CODE_CAPABILITIES,
  detect: (input) => detectClaudeCode(input),
  identify: (input, context) => identifyClaudeCode(input, context),
  deliveryIdentity: (input) => claudeDeliveryIdentity(input),
  deliveryGaps: CLAUDE_DELIVERY_GAPS,
  parse: (input, context) => parseClaudeCode(input, context),
  hookResponse: (): ProviderHookResponse => SILENT_HOOK_RESPONSE,
});
