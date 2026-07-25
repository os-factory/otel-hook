/**
 * Pure command-line parser.
 *
 * Separated from every command implementation so argument handling can be
 * tested without a subprocess, a filesystem, or a collector, and so nothing in
 * the parser can reach `process` — the CLI is handed its argv, environment,
 * and streams (see ADR 0001 on ambient state).
 */

export const CLI_COMMANDS = ["run", "doctor", "providers"] as const;
export type CliCommandName = (typeof CLI_COMMANDS)[number];

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
  readonly stateDir?: string;
  readonly installationId?: string;
  readonly spoolDisabled?: boolean;
  readonly flushTimeoutMillis?: number;
  readonly includeExperimental?: boolean;
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

export type CliCommand = CliRunCommand | CliDoctorCommand | CliProvidersCommand;

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
  "--state-dir",
  "--installation-id",
  "--flush-timeout-ms",
  "--max-input-bytes",
]);

const BOOLEAN_FLAGS = new Set([
  "--json",
  "--no-export",
  "--no-spool",
  "--include-experimental",
  "--no-experimental",
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
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(installationId === undefined ? {} : { installationId }),
    ...(tokens.booleans.has("--no-spool") ? { spoolDisabled: true } : {}),
    ...(flushTimeoutMillis === undefined ? {} : { flushTimeoutMillis }),
    ...(includeExperimental === undefined ? {} : { includeExperimental }),
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

const RUN_FLAGS: ReadonlySet<string> = new Set([...VALUE_FLAGS, "--no-export", "--no-spool", "--include-experimental", "--no-experimental"]);
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
  "--state-dir",
  "--installation-id",
  "--no-spool",
  "--flush-timeout-ms",
  "--include-experimental",
  "--no-experimental",
]);
const PROVIDERS_FLAGS: ReadonlySet<string> = new Set(["--json", "--include-experimental", "--no-experimental"]);

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

Delivery:
  --callback-id <id>         host-supplied delivery id; a repeat of the same id
                             suppresses duplicate telemetry
  --callback-scope <scope>   namespace for --callback-id (default "delivery")

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
  --state-dir <path>         root for session state and the retry spool
  --installation-id <id>     state namespace (not identity)
  --no-spool                 do not persist batches a collector refused
  --flush-timeout-ms <n>     upper bound on flush before exiting (default 2000)
  --max-input-bytes <n>      stdin bound (default 1048576)
  --attr <key=value>         opaque consumer attribute, carried unchanged
  --transport <t>            hook-stdin (default) | cli-argument | library-call
`;
