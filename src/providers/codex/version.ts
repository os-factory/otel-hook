import { providerIdSchema, type ProviderId } from "../../model/primitives.js";

/** Stable identifier for this adapter across releases. */
export const CODEX_PROVIDER_ID: ProviderId = providerIdSchema.parse("codex");

/** Adapter package version, independent of the Codex CLI's own version. */
export const CODEX_ADAPTER_VERSION = "0.1.0";
