import * as path from "node:path";

import { ANTIGRAVITY_PROVIDER_ID } from "../providers/antigravity/adapter.js";
import { CLAUDE_CODE_PROVIDER_ID } from "../providers/claude/detect.js";
import { CODEX_PROVIDER_ID } from "../providers/codex/version.js";
import { CURSOR_PROVIDER_ID } from "../providers/cursor/payload.js";
import { GEMINI_PROVIDER_ID } from "../providers/gemini/adapter.js";

/**
 * Where each provider keeps the configuration document this tool registers into.
 *
 * A path here is a claim about a third party's on-disk layout, so each one names
 * the source that established it. A provider with a verified *planner* but no
 * verified *location* (Antigravity) is deliberately absent: `setup` then requires
 * an explicit `--settings-file`, which is honest about what this repository knows
 * rather than writing a plausible-looking path into a developer's home
 * directory.
 */

export type RegistrationScope = "global" | "project";
export const REGISTRATION_SCOPES: readonly RegistrationScope[] = Object.freeze([
  "global",
  "project",
] as const);

export type InstallLocation = {
  readonly providerId: string;
  readonly scope: RegistrationScope;
  /** Path segments below the home directory (global) or project root (project). */
  readonly segments: readonly string[];
  /** One reviewable sentence naming what verified this path. */
  readonly evidence: string;
};

const CLAUDE_EVIDENCE =
  "code.claude.com/docs/en/hooks settings-file table, cross-checked against o11y-dev/opentelemetry-hooks v0.14.0 setup.sh";
const CODEX_EVIDENCE =
  "learn.chatgpt.com/docs/hooks discovery-locations list, cross-checked against o11y-dev/opentelemetry-hooks v0.14.0 setup.sh";
const GEMINI_EVIDENCE =
  "o11y-dev/opentelemetry-hooks v0.14.0 setup.sh (setup_gemini) and its supported-agents table";
/**
 * Cursor also documents enterprise-managed locations (`/etc/cursor/hooks.json`
 * and the macOS/Windows equivalents). They are deliberately not offered as a
 * scope: they are MDM-owned and outside any home directory.
 */
const CURSOR_EVIDENCE =
  "cursor.com/docs/agent/hooks configuration-levels list (user and project), cross-checked against o11y-dev/opentelemetry-hooks v0.14.0 setup.sh";

export const PROVIDER_INSTALL_LOCATIONS: readonly InstallLocation[] = Object.freeze([
  Object.freeze({
    providerId: CLAUDE_CODE_PROVIDER_ID,
    scope: "global" as const,
    segments: Object.freeze([".claude", "settings.json"]),
    evidence: CLAUDE_EVIDENCE,
  }),
  Object.freeze({
    providerId: CLAUDE_CODE_PROVIDER_ID,
    scope: "project" as const,
    segments: Object.freeze([".claude", "settings.json"]),
    evidence: CLAUDE_EVIDENCE,
  }),
  Object.freeze({
    providerId: CODEX_PROVIDER_ID,
    scope: "global" as const,
    segments: Object.freeze([".codex", "hooks.json"]),
    evidence: CODEX_EVIDENCE,
  }),
  Object.freeze({
    providerId: CODEX_PROVIDER_ID,
    scope: "project" as const,
    segments: Object.freeze([".codex", "hooks.json"]),
    evidence: CODEX_EVIDENCE,
  }),
  Object.freeze({
    providerId: CURSOR_PROVIDER_ID,
    scope: "global" as const,
    segments: Object.freeze([".cursor", "hooks.json"]),
    evidence: CURSOR_EVIDENCE,
  }),
  Object.freeze({
    providerId: CURSOR_PROVIDER_ID,
    scope: "project" as const,
    segments: Object.freeze([".cursor", "hooks.json"]),
    evidence: CURSOR_EVIDENCE,
  }),
  Object.freeze({
    providerId: GEMINI_PROVIDER_ID,
    scope: "global" as const,
    segments: Object.freeze([".gemini", "settings.json"]),
    evidence: GEMINI_EVIDENCE,
  }),
  Object.freeze({
    providerId: GEMINI_PROVIDER_ID,
    scope: "project" as const,
    segments: Object.freeze([".gemini", "settings.json"]),
    evidence: GEMINI_EVIDENCE,
  }),
]);

/**
 * Providers whose planner is verified but whose install location is not, with
 * the blocker. `setup --provider <id> --settings-file <path>` still works.
 */
export const PROVIDERS_WITHOUT_VERIFIED_LOCATION: Readonly<Record<string, string>> = Object.freeze({
  [ANTIGRAVITY_PROVIDER_ID]:
    "no Antigravity hook-file path has been verified; o11y-dev/opentelemetry-hooks v0.14.0 lists Antigravity as " +
    'a "manual hook command, runner-defined" integration and writes no file for it',
});

/**
 * Providers this tool can find on its own, in catalog order.
 *
 * This — not "every provider with a planner" — is what a bare `diagnose`
 * sweeps: a provider whose path must be supplied by hand has nowhere to look.
 */
export const PROVIDERS_WITH_VERIFIED_LOCATION: readonly string[] = Object.freeze([
  ...new Set(PROVIDER_INSTALL_LOCATIONS.map((entry) => entry.providerId)),
]);

export const findInstallLocation = (
  providerId: string,
  scope: RegistrationScope,
): InstallLocation | undefined =>
  PROVIDER_INSTALL_LOCATIONS.find(
    (entry) => entry.providerId === providerId && entry.scope === scope,
  );

export type ScopeRoots = {
  readonly homeDir: string;
  readonly projectDir: string;
};

export const resolveInstallPath = (location: InstallLocation, roots: ScopeRoots): string =>
  path.resolve(
    location.scope === "global" ? roots.homeDir : roots.projectDir,
    ...location.segments,
  );
