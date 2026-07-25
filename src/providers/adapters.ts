/**
 * Curated public entry point for the provider adapters this package ships.
 *
 * Each provider's own barrel (`./claude/index.js`, ...) additionally exports its
 * payload schemas and internal helpers, which are that adapter's private
 * interpretation of a third-party protocol and change whenever the protocol
 * does. Only the stable surface is re-exported here: the adapter factory, the
 * provider id, the declared capabilities, and the hook event names a host needs
 * to register the hook. Nothing in this module can collide across providers,
 * which is why it is hand-listed rather than a set of `export *` lines.
 */
export {
  createClaudeCodeAdapter,
  type ClaudeCodeAdapterOptions,
} from "./claude/adapter.js";
export { CLAUDE_CODE_CAPABILITIES } from "./claude/capabilities.js";
export { CLAUDE_CODE_PROVIDER_ID } from "./claude/detect.js";
export { CLAUDE_HOOK_EVENT_NAMES, type ClaudeHookEventName } from "./claude/schema.js";

export { createCursorAdapter, CURSOR_CAPABILITIES, type CursorAdapterOptions } from "./cursor/adapter.js";
export {
  CURSOR_PROVIDER_ID,
  CURSOR_HOOK_EVENT_NAMES,
  LEGACY_TO_CURRENT_EVENT_NAME as CURSOR_LEGACY_TO_CURRENT_EVENT_NAME,
  type CursorHookEventName,
} from "./cursor/payload.js";

export { createCodexAdapter, CODEX_CAPABILITIES } from "./codex/adapter.js";
export { CODEX_ADAPTER_VERSION, CODEX_PROVIDER_ID } from "./codex/version.js";
export { CODEX_HOOK_EVENT_NAMES, type CodexHookEventName } from "./codex/payload.js";

export {
  createGeminiCliAdapter,
  DEFAULT_GEMINI_CAPABILITIES,
  GEMINI_ADAPTER_VERSION,
  GEMINI_PROVIDER_ID,
  type GeminiAdapterOptions,
} from "./gemini/adapter.js";
export { GEMINI_HOOK_EVENT_NAMES, type GeminiHookEventName } from "./gemini/schema.js";

export {
  ANTIGRAVITY_CAPABILITIES,
  ANTIGRAVITY_PROVIDER_ID,
  createAntigravityAdapter,
  type AntigravityAdapterOptions,
} from "./antigravity/adapter.js";
export {
  ANTIGRAVITY_HOOK_EVENT_NAMES,
  type AntigravityHookEventName,
} from "./antigravity/payload.js";
export {
  ANTIGRAVITY_PROMOTION_GATES,
  ANTIGRAVITY_PROVIDER_MATURITY,
  type AntigravityProviderMaturity,
} from "./antigravity/maturity.js";
