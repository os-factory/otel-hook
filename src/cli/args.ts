/**
 * Pure command-line parser.
 *
 * Separated from every command implementation so argument handling can be
 * tested without a subprocess, a filesystem, or a collector, and so nothing in
 * the parser can reach `process` — the CLI is handed its argv, environment,
 * and streams (see ADR 0001 on ambient state).
 */

import {
  checkResourceAttributeKey,
  MAX_RESOURCE_ATTRIBUTES,
  MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH,
  RESOURCE_ATTRIBUTE_KEY_REJECTION_DETAIL,
} from "../config/resource-attributes.js";

export const CLI_COMMANDS = [
  "run",
  "doctor",
  "providers",
  "setup",
  "diagnose",
  "uninstall",
] as const;
export type CliCommandName = (typeof CLI_COMMANDS)[number];

/** Which of a provider's two documented configuration files to act on. */
export type CliRegistrationScope = "global" | "project";

/** Exporter and runtime policy. Deliberately holds no identity field (ADR 0001). */
export type CliPolicyFlags = {
  readonly configFile?: string;
  readonly endpoint?: string;
  readonly protocol?: "http/protobuf" | "http/json" | "none";
  readonly serviceName?: string;
  readonly serviceNamespace?: string;
  readonly timeoutMillis?: number;
  readonly exportDisabled?: boolean;
  readonly contentMode?: string;
  readonly logLevel?: string;
  /** Header *values*, kept out of any resolved-config snapshot. */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Custom OTLP resource attributes describing this deployment. Exporter
   * policy, not identity, and a different flag and field from a run command's
   * `consumerAttributes`.
   */
  readonly resourceAttributes: Readonly<Record<string, string>>;
  readonly stateDir?: string;
  readonly installationId?: string;
  readonly spoolDisabled?: boolean;
  readonly flushTimeoutMillis?: number;
  readonly includeExperimental?: boolean;
  /** Enable the OTLP logs signal alongside traces. Off unless asked for. */
  readonly logsEnabled?: boolean;
  /** Full logs URL. Derived from `endpoint` when absent. */
  readonly logsEndpoint?: string;
  /**
   * Permit disclosed content text in a log body.
   *
   * A separate flag from `--content-mode` because they answer different questions:
   * that one decides what the privacy service discloses at all, this one decides
   * whether the logs pipeline may carry it. Both are needed for a body to appear.
   */
  readonly logsIncludeContent?: boolean;
};

/**
 * Immutable invocation identity asserted by the caller. Separate type from
 * {@link CliPolicyFlags} with no shared field names, so no configuration path
 * can set identity and no identity path can set configuration.
 */
export type CliIdentityFlags = {
  readonly sessionId?: string;
  readonly invocationId?: string;
  readonly parentInvocationId?: string;
  readonly rootSessionId?: string;
  readonly agentInstanceId?: string;
  readonly identityFile?: string;
};

export type CliRunCommand = {
  readonly name: "run";
  readonly providerId?: string;
  readonly transport: "hook-stdin" | "cli-argument" | "library-call";
  readonly identity: CliIdentityFlags;
  readonly policy: CliPolicyFlags;
  readonly callbackId?: string;
  readonly callbackScope?: string;
  /** Report every callback that could not be deduplicated, and why. */
  readonly requireCallbackId?: boolean;
  /** Do not normalize a delivery id from the payload when none is supplied. */
  readonly noDeriveCallbackId?: boolean;
  readonly consumerAttributes: Readonly<Record<string, string>>;
  readonly maxInputBytes: number;
};

export type CliDoctorCommand = {
  readonly name: "doctor";
  readonly json: boolean;
  readonly policy: CliPolicyFlags;
};

export type CliProvidersCommand = {
  readonly name: "providers";
  readonly json: boolean;
  readonly includeExperimental: boolean;
};

/**
 * `setup`, `diagnose`, and `uninstall` share one command type because they take
 * the same target selection and differ only in what they do once a target is
 * resolved — which is also how `install/lifecycle.ts` implements them.
 */
export type CliRegistrationCommand = {
  readonly name: "setup" | "diagnose" | "uninstall";
  readonly json: boolean;
  readonly dryRun: boolean;
  /** Empty means "every provider with a verified configuration path" (diagnose only). */
  readonly providerIds: readonly string[];
  readonly scopes: readonly CliRegistrationScope[];
  readonly projectDir?: string;
  readonly homeDir?: string;
  /** Overrides the provider's documented configuration path. */
  readonly settingsFile?: string;
  readonly hookCommand?: string;
  readonly events?: readonly string[];
  readonly matcher?: string;
  readonly timeoutSeconds?: number;
  readonly managedMarker?: string;
};

export type CliCommand =
  | CliRunCommand
  | CliDoctorCommand
  | CliProvidersCommand
  | CliRegistrationCommand;

export type CliParseResult =
  | { readonly status: "command"; readonly command: CliCommand }
  | { readonly status: "version" }
  | { readonly status: "help"; readonly topic?: CliCommandName }
  | { readonly status: "error"; readonly errors: readonly string[] };

/** Default cap on stdin. One hook payload is kilobytes; a megabyte is generous. */
export const DEFAULT_MAX_INPUT_BYTES = 1_048_576;
export const MAX_ALLOWED_INPUT_BYTES = 16 * 1_048_576;

const VALUE_FLAGS = new Set([
  "--provider",
  "--transport",
  "--session-id",
  "--invocation-id",
  "--parent-invocation-id",
  "--root-session-id",
  "--agent-instance-id",
  "--identity-file",
  "--callback-id",
  "--callback-scope",
  "--config-file",
  "--endpoint",
  "--protocol",
  "--service-name",
  "--service-namespace",
  "--timeout-ms",
  "--content-mode",
  "--log-level",
  "--header",
  "--attr",
  "--resource-attr",
  "--state-dir",
  "--installation-id",
  "--flush-timeout-ms",
  "--logs-endpoint",
  "--max-input-bytes",
  "--scope",
  "--project-dir",
  "--home-dir",
  "--settings-file",
  "--hook-command",
  "--event",
  "--matcher",
  "--timeout-seconds",
  "--managed-marker",
]);

const BOOLEAN_FLAGS = new Set([
  "--json",
  "--no-export",
  "--no-spool",
  "--logs",
  "--no-logs",
  "--logs-content",
  "--include-experimental",
  "--no-experimental",
  "--dry-run",
  "--require-callback-id",
  "--no-derive-callback-id",
]);

type Tokenized = {
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly booleans: ReadonlySet<string>;
  readonly errors: readonly string[];
};

const tokenize = (argv: readonly string[]): Tokenized => {
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  const errors: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith("--")) {
      errors.push(`unexpected positional argument "${token}"`);
      continue;
    }

    const equals = token.indexOf("=");
    const flag = equals === -1 ? token : token.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);

    if (BOOLEAN_FLAGS.has(flag)) {
      if (inlineValue !== undefined) {
        errors.push(`flag ${flag} does not take a value`);
        continue;
      }
      booleans.add(flag);
      continue;
    }

    if (!VALUE_FLAGS.has(flag)) {
      errors.push(`unknown flag ${flag}`);
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        errors.push(`flag ${flag} requires a value`);
        continue;
      }
      value = next;
      index += 1;
    }
    const existing = values.get(flag) ?? [];
    existing.push(value);
    values.set(flag, existing);
  }

  return { values, booleans, errors };
};

const single = (
  tokens: Tokenized,
  flag: string,
  errors: string[],
): string | undefined => {
  const found = tokens.values.get(flag);
  if (found === undefined) {
    return undefined;
  }
  if (found.length > 1) {
    errors.push(`flag ${flag} was given ${String(found.length)} times; it accepts one value`);
  }
  return found[found.length - 1];
};

const integer = (
  tokens: Tokenized,
  flag: string,
  errors: string[],
  bounds: { readonly min: number; readonly max: number },
): number | undefined => {
  const raw = single(tokens, flag, errors);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    errors.push(
      `flag ${flag} expects an integer between ${String(bounds.min)} and ${String(bounds.max)}, got "${raw}"`,
    );
    return undefined;
  }
  return parsed;
};

const keyValuePairs = (
  tokens: Tokenized,
  flag: string,
  errors: string[],
): Readonly<Record<string, string>> => {
  const pairs: Record<string, string> = {};
  for (const entry of tokens.values.get(flag) ?? []) {
    const equals = entry.indexOf("=");
    if (equals <= 0) {
      errors.push(`flag ${flag} expects key=value, got "${entry}"`);
      continue;
    }
    pairs[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  return pairs;
};

/**
 * Parse repeated `--resource-attr key=value` flags.
 *
 * Separate from {@link keyValuePairs} because these pairs are validated: a
 * reserved, malformed, or secret-looking key is a usage error the operator can
 * fix now, rather than a silently dropped attribute discovered later in a
 * collector. Keys appear in the error text — the operator just typed them —
 * but values never do.
 */
const resourceAttributePairs = (
  tokens: Tokenized,
  errors: string[],
): Readonly<Record<string, string>> => {
  const pairs: Record<string, string> = {};
  for (const entry of tokens.values.get("--resource-attr") ?? []) {
    const equals = entry.indexOf("=");
    if (equals <= 0) {
      errors.push("flag --resource-attr expects key=value");
      continue;
    }
    const key = entry.slice(0, equals).trim();
    const value = entry.slice(equals + 1);
    const rejection = checkResourceAttributeKey(key);
    if (rejection !== undefined) {
      errors.push(
        `flag --resource-attr rejected key "${key}": ${RESOURCE_ATTRIBUTE_KEY_REJECTION_DETAIL[rejection]}`,
      );
      continue;
    }
    if (value.length > MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH) {
      errors.push(
        `flag --resource-attr value for "${key}" exceeds ${String(MAX_RESOURCE_ATTRIBUTE_VALUE_LENGTH)} characters`,
      );
      continue;
    }
    pairs[key] = value;
  }
  if (Object.keys(pairs).length > MAX_RESOURCE_ATTRIBUTES) {
    errors.push(
      `flag --resource-attr accepts at most ${String(MAX_RESOURCE_ATTRIBUTES)} attributes`,
    );
  }
  return pairs;
};

const parsePolicy = (tokens: Tokenized, errors: string[]): CliPolicyFlags => {
  const protocolRaw = single(tokens, "--protocol", errors);
  let protocol: CliPolicyFlags["protocol"];
  if (protocolRaw !== undefined) {
    if (protocolRaw === "http/protobuf" || protocolRaw === "http/json" || protocolRaw === "none") {
      protocol = protocolRaw;
    } else {
      errors.push(`flag --protocol expects http/protobuf, http/json, or none, got "${protocolRaw}"`);
    }
  }

  const includeExperimental = tokens.booleans.has("--include-experimental")
    ? true
    : tokens.booleans.has("--no-experimental")
      ? false
      : undefined;
  if (tokens.booleans.has("--include-experimental") && tokens.booleans.has("--no-experimental")) {
    errors.push("flags --include-experimental and --no-experimental cannot both be given");
  }

  const configFile = single(tokens, "--config-file", errors);
  const endpoint = single(tokens, "--endpoint", errors);
  const serviceName = single(tokens, "--service-name", errors);
  const serviceNamespace = single(tokens, "--service-namespace", errors);
  const contentMode = single(tokens, "--content-mode", errors);
  const logLevel = single(tokens, "--log-level", errors);
  const stateDir = single(tokens, "--state-dir", errors);
  const installationId = single(tokens, "--installation-id", errors);
  const timeoutMillis = integer(tokens, "--timeout-ms", errors, { min: 1, max: 600_000 });
  const flushTimeoutMillis = integer(tokens, "--flush-timeout-ms", errors, { min: 1, max: 60_000 });
  const logsEndpoint = single(tokens, "--logs-endpoint", errors);

  const logsEnabled = tokens.booleans.has("--logs")
    ? true
    : tokens.booleans.has("--no-logs")
      ? false
      : undefined;
  if (tokens.booleans.has("--logs") && tokens.booleans.has("--no-logs")) {
    errors.push("flags --logs and --no-logs cannot both be given");
  }

  return {
    ...(configFile === undefined ? {} : { configFile }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(protocol === undefined ? {} : { protocol }),
    ...(serviceName === undefined ? {} : { serviceName }),
    ...(serviceNamespace === undefined ? {} : { serviceNamespace }),
    ...(timeoutMillis === undefined ? {} : { timeoutMillis }),
    ...(tokens.booleans.has("--no-export") ? { exportDisabled: true } : {}),
    ...(contentMode === undefined ? {} : { contentMode }),
    ...(logLevel === undefined ? {} : { logLevel }),
    headers: keyValuePairs(tokens, "--header", errors),
    resourceAttributes: resourceAttributePairs(tokens, errors),
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(installationId === undefined ? {} : { installationId }),
    ...(tokens.booleans.has("--no-spool") ? { spoolDisabled: true } : {}),
    ...(flushTimeoutMillis === undefined ? {} : { flushTimeoutMillis }),
    ...(includeExperimental === undefined ? {} : { includeExperimental }),
    ...(logsEnabled === undefined ? {} : { logsEnabled }),
    ...(logsEndpoint === undefined ? {} : { logsEndpoint }),
    ...(tokens.booleans.has("--logs-content") ? { logsIncludeContent: true } : {}),
  };
};

const parseIdentity = (tokens: Tokenized, errors: string[]): CliIdentityFlags => {
  const sessionId = single(tokens, "--session-id", errors);
  const invocationId = single(tokens, "--invocation-id", errors);
  const parentInvocationId = single(tokens, "--parent-invocation-id", errors);
  const rootSessionId = single(tokens, "--root-session-id", errors);
  const agentInstanceId = single(tokens, "--agent-instance-id", errors);
  const identityFile = single(tokens, "--identity-file", errors);
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(invocationId === undefined ? {} : { invocationId }),
    ...(parentInvocationId === undefined ? {} : { parentInvocationId }),
    ...(rootSessionId === undefined ? {} : { rootSessionId }),
    ...(agentInstanceId === undefined ? {} : { agentInstanceId }),
    ...(identityFile === undefined ? {} : { identityFile }),
  };
};

const rejectFlagsFor = (
  command: CliCommandName,
  tokens: Tokenized,
  allowed: ReadonlySet<string>,
  errors: string[],
): void => {
  for (const flag of [...tokens.values.keys(), ...tokens.booleans]) {
    if (!allowed.has(flag)) {
      errors.push(`flag ${flag} is not accepted by "${command}"`);
    }
  }
};

/**
 * Listed explicitly rather than derived from {@link VALUE_FLAGS}: that set is
 * the tokenizer's vocabulary for *every* command, so deriving from it would
 * silently make each new command's flags acceptable to `run` too — including
 * the registration flags, which must never be accepted by `run`.
 */
const RUN_FLAGS: ReadonlySet<string> = new Set([
  "--provider",
  "--transport",
  "--session-id",
  "--invocation-id",
  "--parent-invocation-id",
  "--root-session-id",
  "--agent-instance-id",
  "--identity-file",
  "--callback-id",
  "--callback-scope",
  "--config-file",
  "--endpoint",
  "--protocol",
  "--service-name",
  "--service-namespace",
  "--timeout-ms",
  "--content-mode",
  "--log-level",
  "--header",
  "--attr",
  "--resource-attr",
  "--state-dir",
  "--installation-id",
  "--flush-timeout-ms",
  "--logs",
  "--no-logs",
  "--logs-endpoint",
  "--logs-content",
  "--max-input-bytes",
  "--no-export",
  "--no-spool",
  "--include-experimental",
  "--no-experimental",
  "--require-callback-id",
  "--no-derive-callback-id",
]);
const DOCTOR_FLAGS: ReadonlySet<string> = new Set([
  "--json",
  "--config-file",
  "--endpoint",
  "--protocol",
  "--service-name",
  "--service-namespace",
  "--timeout-ms",
  "--no-export",
  "--content-mode",
  "--log-level",
  "--header",
  "--resource-attr",
  "--state-dir",
  "--installation-id",
  "--no-spool",
  "--flush-timeout-ms",
  "--logs",
  "--no-logs",
  "--logs-endpoint",
  "--logs-content",
  "--include-experimental",
  "--no-experimental",
]);
const PROVIDERS_FLAGS: ReadonlySet<string> = new Set(["--json", "--include-experimental", "--no-experimental"]);
const REGISTRATION_FLAGS: ReadonlySet<string> = new Set([
  "--json",
  "--dry-run",
  "--provider",
  "--scope",
  "--project-dir",
  "--home-dir",
  "--settings-file",
  "--hook-command",
  "--event",
  "--matcher",
  "--timeout-seconds",
  "--managed-marker",
]);

const REGISTRATION_COMMANDS: ReadonlySet<string> = new Set(["setup", "diagnose", "uninstall"]);

const multiple = (tokens: Tokenized, flag: string): readonly string[] =>
  tokens.values.get(flag) ?? [];

const parseScopes = (
  raw: string | undefined,
  fallback: readonly CliRegistrationScope[],
  errors: string[],
): readonly CliRegistrationScope[] => {
  if (raw === undefined) {
    return fallback;
  }
  if (raw === "global" || raw === "project") {
    return [raw];
  }
  if (raw === "all") {
    return ["global", "project"];
  }
  errors.push(`flag --scope expects global, project, or all, got "${raw}"`);
  return fallback;
};

const parseRegistrationCommand = (
  name: CliRegistrationCommand["name"],
  tokens: Tokenized,
  errors: string[],
): CliParseResult => {
  rejectFlagsFor(name, tokens, REGISTRATION_FLAGS, errors);

  const providerIds = multiple(tokens, "--provider");
  // `setup` and `uninstall` mutate a file, so they never guess which one:
  // "every provider I could find" is a reasonable default for a report and a
  // bad one for a write.
  if (name !== "diagnose" && providerIds.length === 0) {
    errors.push(`"${name}" requires --provider <id>`);
  }

  const events = multiple(tokens, "--event");
  if (events.length > 0 && name === "diagnose") {
    errors.push("flag --event is not accepted by \"diagnose\"; it reports the provider's own event set");
  }

  // Project scope by default for the mutating commands: writing into a
  // developer's home directory is the surprising choice, so it is opt-in.
  const scopes = parseScopes(
    single(tokens, "--scope", errors),
    name === "diagnose" ? (["global", "project"] as const) : (["project"] as const),
    errors,
  );

  const projectDir = single(tokens, "--project-dir", errors);
  const homeDir = single(tokens, "--home-dir", errors);
  const settingsFile = single(tokens, "--settings-file", errors);
  const hookCommand = single(tokens, "--hook-command", errors);
  const matcher = single(tokens, "--matcher", errors);
  const managedMarker = single(tokens, "--managed-marker", errors);
  const timeoutSeconds = integer(tokens, "--timeout-seconds", errors, { min: 1, max: 3_600 });

  if (settingsFile !== undefined && scopes.length > 1) {
    errors.push("flag --settings-file names one document, so --scope all cannot be used with it");
  }
  if (tokens.booleans.has("--dry-run") && name === "diagnose") {
    errors.push('flag --dry-run is not accepted by "diagnose"; it never writes');
  }

  if (errors.length > 0) {
    return { status: "error", errors };
  }

  return {
    status: "command",
    command: {
      name,
      json: tokens.booleans.has("--json"),
      dryRun: tokens.booleans.has("--dry-run"),
      providerIds,
      scopes,
      ...(projectDir === undefined ? {} : { projectDir }),
      ...(homeDir === undefined ? {} : { homeDir }),
      ...(settingsFile === undefined ? {} : { settingsFile }),
      ...(hookCommand === undefined ? {} : { hookCommand }),
      ...(events.length === 0 ? {} : { events }),
      ...(matcher === undefined ? {} : { matcher }),
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
      ...(managedMarker === undefined ? {} : { managedMarker }),
    },
  };
};

export const parseCliArgs = (argv: readonly string[]): CliParseResult => {
  const [first, ...rest] = argv;

  if (first === undefined) {
    return { status: "help" };
  }
  if (first === "--version" || first === "-v") {
    return argv.length === 1
      ? { status: "version" }
      : { status: "error", errors: ["--version takes no other arguments"] };
  }
  if (first === "--help" || first === "-h") {
    return { status: "help" };
  }
  if (!CLI_COMMANDS.includes(first as CliCommandName)) {
    return {
      status: "error",
      errors: [`unknown command "${first}"; expected one of ${CLI_COMMANDS.join(", ")}`],
    };
  }
  const command = first as CliCommandName;
  if (rest.includes("--help") || rest.includes("-h")) {
    return { status: "help", topic: command };
  }

  const tokens = tokenize(rest);
  const errors = [...tokens.errors];

  if (command === "providers") {
    rejectFlagsFor(command, tokens, PROVIDERS_FLAGS, errors);
    if (errors.length > 0) {
      return { status: "error", errors };
    }
    return {
      status: "command",
      command: {
        name: "providers",
        json: tokens.booleans.has("--json"),
        includeExperimental: !tokens.booleans.has("--no-experimental"),
      },
    };
  }

  if (REGISTRATION_COMMANDS.has(command)) {
    return parseRegistrationCommand(command as CliRegistrationCommand["name"], tokens, errors);
  }

  if (command === "doctor") {
    rejectFlagsFor(command, tokens, DOCTOR_FLAGS, errors);
    const policy = parsePolicy(tokens, errors);
    if (errors.length > 0) {
      return { status: "error", errors };
    }
    return {
      status: "command",
      command: { name: "doctor", json: tokens.booleans.has("--json"), policy },
    };
  }

  rejectFlagsFor(command, tokens, RUN_FLAGS, errors);
  const transportRaw = single(tokens, "--transport", errors) ?? "hook-stdin";
  if (
    transportRaw !== "hook-stdin" &&
    transportRaw !== "cli-argument" &&
    transportRaw !== "library-call"
  ) {
    errors.push(
      `flag --transport expects hook-stdin, cli-argument, or library-call, got "${transportRaw}"`,
    );
  }
  const providerId = single(tokens, "--provider", errors);
  const callbackId = single(tokens, "--callback-id", errors);
  const callbackScope = single(tokens, "--callback-scope", errors);
  if (callbackScope !== undefined && callbackId === undefined) {
    errors.push("flag --callback-scope requires --callback-id");
  }
  const requireCallbackId = tokens.booleans.has("--require-callback-id");
  const noDeriveCallbackId = tokens.booleans.has("--no-derive-callback-id");
  const maxInputBytes =
    integer(tokens, "--max-input-bytes", errors, { min: 1, max: MAX_ALLOWED_INPUT_BYTES }) ??
    DEFAULT_MAX_INPUT_BYTES;
  const identity = parseIdentity(tokens, errors);
  const policy = parsePolicy(tokens, errors);
  const consumerAttributes = keyValuePairs(tokens, "--attr", errors);

  if (errors.length > 0) {
    return { status: "error", errors };
  }

  return {
    status: "command",
    command: {
      name: "run",
      ...(providerId === undefined ? {} : { providerId }),
      transport: transportRaw as CliRunCommand["transport"],
      identity,
      policy,
      ...(callbackId === undefined ? {} : { callbackId }),
      ...(callbackScope === undefined ? {} : { callbackScope }),
      ...(requireCallbackId ? { requireCallbackId } : {}),
      ...(noDeriveCallbackId ? { noDeriveCallbackId } : {}),
      consumerAttributes,
      maxInputBytes,
    },
  };
};

export const CLI_USAGE = `otel-hook — provider-neutral coding-agent telemetry

Usage:
  otel-hook run [--provider <id>] [options]   process one hook payload from stdin
  otel-hook doctor [--json]                   report configuration and delivery health
  otel-hook providers [--json]                list adapters and their capabilities
  otel-hook setup --provider <id> [options]   register this hook in a provider's config
  otel-hook diagnose [--json]                 report what is registered where
  otel-hook uninstall --provider <id>         remove this hook from a provider's config
  otel-hook --version

"run" reads exactly one JSON value from stdin, writes only what the selected
provider's protocol requires to stdout, sends every diagnostic to stderr, and
always exits 0 so telemetry can never fail the host agent.

Provider selection:
  --provider <id>            explicit provider; always preferred
                             (without it, detection must be unambiguous and
                             never falls back to a default provider)
  --no-experimental          exclude experimental adapters from detection

Invocation identity (immutable, per invocation, never from the environment):
  --session-id <id>          assert the session this observation belongs to
  --invocation-id <id>       assert this invocation's id
  --parent-invocation-id <id>
  --root-session-id <id>
  --agent-instance-id <id>
  --identity-file <path>     JSON with any of the fields above, plus
                             "startedAt" and a "workspace" identity
  A caller assertion that disagrees with the provider payload is a conflict:
  attribution is declined rather than guessed.

Delivery deduplication (at most once per callback, across process restarts):
  --callback-id <id>         host-supplied delivery id; a repeat of the same id
                             suppresses duplicate telemetry
  --callback-scope <scope>   namespace for --callback-id (default "delivery")
  Without --callback-id, the selected adapter is asked whether the payload
  carries a replay-stable identifier of its own (a tool-call id, a turn id, a
  provider-recorded timestamp); see "providers" for per-adapter coverage.
  --require-callback-id      report every callback that could not be deduplicated,
                             naming the provider and the missing capability
  --no-derive-callback-id    never normalize an identifier from the payload;
                             deduplicate only against --callback-id

Exporter and runtime policy (never identity):
  --config-file <path>       JSON configuration patch
  --endpoint <url>           OTLP HTTP/protobuf traces endpoint
  --protocol <p>             http/protobuf | http/json | none
  --service-name <name>      --service-namespace <ns>
  --timeout-ms <n>           per-export timeout
  --no-export                disable the exporter entirely
  --content-mode <mode>      omit (default) | mask | redact | raw
  --log-level <level>        silent | error | warn | info | debug
  --header <name=value>      exporter header; only its name enters any snapshot
  --resource-attr <key=value>
                             custom OTLP resource attribute for this deployment,
                             merged per key over OTEL_RESOURCE_ATTRIBUTES and the
                             config file. service.name and service.namespace are
                             refused here; use --service-name/--service-namespace
  --state-dir <path>         root for session state and the retry spool
  --installation-id <id>     state namespace (not identity)
  --no-spool                 do not persist batches a collector refused
  --flush-timeout-ms <n>     upper bound on flush before exiting (default 2000)
  --logs                     also export OTLP logs (off by default)
  --logs-endpoint <url>      OTLP HTTP/protobuf logs endpoint; derived from
                             --endpoint when omitted (/v1/traces -> /v1/logs)
  --logs-content             permit disclosed content text in a log body. Needs
                             --content-mode too: this decides whether the logs
                             pipeline may carry what that one discloses
  --max-input-bytes <n>      stdin bound (default 1048576)
  --attr <key=value>         opaque consumer attribute for this invocation,
                             carried unchanged (not a resource attribute)
  --transport <t>            hook-stdin (default) | cli-argument | library-call

Registration lifecycle (setup / diagnose / uninstall):
  --provider <id>            provider to act on; repeatable. Required for setup
                             and uninstall; diagnose defaults to every provider
                             whose configuration path this build has verified
  --scope <s>                global | project | all. setup and uninstall default
                             to project; diagnose defaults to all
  --project-dir <path>       project root for project scope (default: cwd)
  --home-dir <path>          home directory for global scope
  --settings-file <path>     write this exact document instead of the provider's
                             documented path; required for a provider whose
                             planner is verified but whose path is not
  --hook-command <cmd>       command to register
                             (default "otel-hook run --provider <id>")
  --event <name>             register only these events; repeatable
  --matcher <m>              matcher for a newly created hook group
  --timeout-seconds <n>      per-hook timeout written into the config
  --managed-marker <token>   substring that identifies this tool's own entries
                             across versions (default "otel-hook")
  --dry-run                  print the exact document that would be written
  --json                     machine-readable report

setup is idempotent, preserves unrelated configuration and file formatting,
writes atomically under a lock, and refuses rather than overwrites a document it
cannot parse. uninstall removes exactly what setup added.
`;
