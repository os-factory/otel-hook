import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import type { Socket } from "node:net";
import path from "node:path";

import { ExportResultCode, type ExportResult } from "@opentelemetry/core";

import {
  DEFAULT_ENDPOINT_DOWN_MILLIS,
  effectiveExportTimeoutMillis,
  type ExporterPolicy,
} from "../config/schema.js";
import type { Clock, Logger } from "../runtime/ports.js";

/**
 * Bounded delivery to an endpoint that may be down.
 *
 * The host agent waits for its hooks. Before this, one `otel-hook run` against a
 * collector that refused connections took ~20 s (the OTLP exporter retries a
 * refused connection with backoff until its 10 s timeout, once per signal, then
 * again for the spool drain), and against a host that never answered a SYN it
 * waited for the kernel's connect timeout (minutes): Node's request timeout only
 * starts once a socket is connected. Three bounds fix that:
 *
 * 1. {@link boundedExporterOptions}: every OTLP request gets `timeoutMillis`
 *    capped by `exporter.exportBudgetMillis`, and an HTTP agent whose sockets
 *    give up connecting after the same budget. The exporter's own retries live
 *    inside that budget.
 * 2. {@link EndpointGate}: the first unreachable result (no HTTP answer at all,
 *    see {@link isUnreachableExportFailure}) in a process marks the
 *    endpoint down for that process, so its other signals and its spool drain
 *    spool at once instead of paying the budget again.
 * 3. The mark is also written to the state directory
 *    (`<state>/endpoint-health/<digest>.json`) for `exporter.endpointDownMillis`,
 *    so the next hooks spool without trying. When the window ends, the first hook
 *    to see it claims a short probe window and tries; a success removes the mark
 *    and the spool drains as before.
 *
 * Keyed by the endpoint's origin (scheme, host, port), so every destination,
 * signal and provider namespace sending to one collector shares what is known
 * about it. The file holds timestamps and a counter, never a URL.
 */

/** Error code of the result {@link guardExport} returns for an endpoint marked down. */
export const ENDPOINT_DOWN_ERROR_CODE = "OTEL_HOOK_ENDPOINT_DOWN";

/** Network failures (no HTTP status) that mean "could not reach it". */
const UNREACHABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "ENETDOWN",
  "EAI_AGAIN",
  "ENOTFOUND",
  ENDPOINT_DOWN_ERROR_CODE,
]);

/**
 * Whether a failed export means the endpoint could not be reached at all: the
 * connection was refused, reset or timed out, the name did not resolve, or the
 * request got no answer within its timeout.
 *
 * Any HTTP answer — a 2xx, a refusal of the batch, even a 503 — says the
 * endpoint is up, and is not this: it costs a hook one bounded request, never a
 * stall, and a collector that is merely shedding load recovers without waiting
 * out a down window.
 */
export const isUnreachableExportFailure = (result: ExportResult): boolean => {
  if (result.code === ExportResultCode.SUCCESS) {
    return false;
  }
  const error = result.error as { readonly code?: unknown; readonly message?: unknown } | undefined;
  const code = error?.code;
  if (typeof code === "string") {
    return UNREACHABLE_NETWORK_CODES.has(code);
  }
  if (code !== undefined) {
    return false;
  }
  // The exporter reports a request that got no answer in time as a plain error.
  return typeof error?.message === "string" && /timed out/i.test(error.message);
};

type AgentWithConnection = {
  createConnection: (options: unknown, callback?: unknown) => Socket | undefined;
};

/**
 * An agent whose sockets are destroyed with `ETIMEDOUT` when they have not
 * connected within `connectTimeoutMillis`. A SYN to a blackholed host otherwise
 * waits for the kernel, which no request timeout covers.
 */
const withConnectTimeout = <A extends http.Agent>(agent: A, connectTimeoutMillis: number): A => {
  const target = agent as unknown as AgentWithConnection;
  const original = target.createConnection.bind(agent);
  target.createConnection = (options: unknown, callback?: unknown): Socket | undefined => {
    const socket = original(options, callback);
    if (socket !== undefined && socket.connecting) {
      const timer = setTimeout(() => {
        const error = Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" });
        socket.destroy(error);
      }, connectTimeoutMillis);
      timer.unref();
      const clear = (): void => {
        clearTimeout(timer);
      };
      socket.once("connect", clear);
      socket.once("close", clear);
    }
    return socket;
  };
  return agent;
};

/**
 * Constructor options for an OTLP HTTP exporter used by a hook: the request
 * timeout capped by the export budget, and an agent with a connect timeout.
 */
export const boundedExporterOptions = (
  exporter: ExporterPolicy,
): {
  readonly timeoutMillis: number;
  readonly httpAgentOptions: (protocol: string) => http.Agent;
} => {
  const timeoutMillis = effectiveExportTimeoutMillis(exporter);
  let agents: { http?: http.Agent; https?: https.Agent } = {};
  return {
    timeoutMillis,
    httpAgentOptions: (protocol: string): http.Agent => {
      if (protocol === "https:") {
        agents = { ...agents, https: agents.https ?? withConnectTimeout(new https.Agent({ keepAlive: true }), timeoutMillis) };
        return agents.https as http.Agent;
      }
      agents = { ...agents, http: agents.http ?? withConnectTimeout(new http.Agent({ keepAlive: true }), timeoutMillis) };
      return agents.http as http.Agent;
    },
  };
};

/** What one process knows about one endpoint. */
export interface EndpointGate {
  /** False while the endpoint is marked down: spool without sending. */
  available(): Promise<boolean>;
  /** Fold an export result in: unreachable marks down, success clears the mark. */
  record(result: ExportResult): Promise<void>;
}

export interface EndpointHealth {
  /** The gate of an endpoint URL's origin; `undefined` for a URL that does not parse. */
  gateFor(url: string | undefined): EndpointGate | undefined;
}

export type EndpointHealthOptions = {
  /** State root; the marks live in `<rootDir>/endpoint-health/`. Absent: in-process only. */
  readonly rootDir?: string;
  readonly clock: Clock;
  readonly logger?: Logger;
  /** `exporter.endpointDownMillis`. */
  readonly downMillis?: number;
  /** How long a probing hook holds the others off; default the export budget plus 1 s. */
  readonly probeMillis: number;
};

type Mark = { readonly downUntil: number; readonly failures: number };

const parseMark = (raw: string): Mark | undefined => {
  try {
    const parsed = JSON.parse(raw) as { downUntil?: unknown; failures?: unknown };
    return typeof parsed.downUntil === "number" && Number.isFinite(parsed.downUntil)
      ? {
          downUntil: parsed.downUntil,
          failures: typeof parsed.failures === "number" && Number.isInteger(parsed.failures) ? parsed.failures : 1,
        }
      : undefined;
  } catch {
    return undefined;
  }
};

const originOf = (url: string | undefined): string | undefined => {
  if (url === undefined) {
    return undefined;
  }
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

export const createEndpointHealth = (options: EndpointHealthOptions): EndpointHealth => {
  const downMillis = options.downMillis ?? DEFAULT_ENDPOINT_DOWN_MILLIS;
  const gates = new Map<string, EndpointGate>();

  const createGate = (origin: string): EndpointGate => {
    const digest = createHash("sha256").update(origin, "utf8").digest("hex").slice(0, 32);
    const dir = options.rootDir === undefined ? undefined : path.join(options.rootDir, "endpoint-health");
    const file = dir === undefined ? undefined : path.join(dir, `${digest}.json`);
    /** In-process: down until this instant (0 = not known down). */
    let downUntil = 0;
    let failures = 0;
    /** Whether a mark file is (or may be) on disk. */
    let marked = false;
    let loaded: Promise<void> | undefined;
    let warned = false;

    const write = async (mark: Mark): Promise<void> => {
      if (file === undefined || dir === undefined) {
        return;
      }
      try {
        await mkdir(dir, { recursive: true });
        const tmp = path.join(dir, `.tmp-${randomBytes(6).toString("hex")}.json`);
        await writeFile(tmp, `${JSON.stringify(mark)}\n`);
        await rename(tmp, file);
        marked = true;
      } catch {
        // Fail open: the in-process mark still holds for this invocation.
      }
    };

    const load = (): Promise<void> => {
      loaded ??= (async () => {
        if (file === undefined) {
          return;
        }
        let raw: string;
        try {
          raw = await readFile(file, "utf8");
        } catch {
          return;
        }
        marked = true;
        const mark = parseMark(raw);
        if (mark === undefined) {
          return;
        }
        failures = mark.failures;
        const now = options.clock.now();
        if (mark.downUntil > now) {
          downUntil = mark.downUntil;
          return;
        }
        // The window is over: this process probes. Holding the others off for the
        // probe keeps a burst of hooks from all paying the budget at once.
        await write({ downUntil: now + options.probeMillis, failures });
      })();
      return loaded;
    };

    return {
      available: async (): Promise<boolean> => {
        if (downMillis === 0) {
          return true;
        }
        await load();
        return options.clock.now() >= downUntil;
      },
      record: async (result: ExportResult): Promise<void> => {
        if (downMillis === 0) {
          return;
        }
        if (!isUnreachableExportFailure(result)) {
          // Delivered, or refused with a status: either way the endpoint answered.
          if (!marked && downUntil === 0) {
            return;
          }
          downUntil = 0;
          failures = 0;
          marked = false;
          if (file !== undefined) {
            await unlink(file).catch(() => undefined);
          }
          return;
        }
        failures += 1;
        downUntil = options.clock.now() + downMillis;
        if (!warned) {
          warned = true;
          options.logger?.warn("export endpoint unreachable; hooks spool for it without trying until it is probed again", {
            "export.endpoint_down_millis": downMillis,
            "export.endpoint_failures": failures,
          });
        }
        await write({ downUntil, failures });
      },
    };
  };

  return {
    gateFor: (url: string | undefined): EndpointGate | undefined => {
      const origin = originOf(url);
      if (origin === undefined) {
        return undefined;
      }
      let gate = gates.get(origin);
      if (gate === undefined) {
        gate = createGate(origin);
        gates.set(origin, gate);
      }
      return gate;
    },
  };
};

/**
 * Run one export through an endpoint's gate: skipped (a non-permanent failure,
 * so the caller spools it) while the endpoint is marked down, recorded otherwise.
 * Without a gate, `send` runs as it always did.
 */
export const guardExport = async (
  gate: EndpointGate | undefined,
  send: () => Promise<ExportResult>,
): Promise<ExportResult> => {
  if (gate === undefined) {
    return send();
  }
  if (!(await gate.available())) {
    return {
      code: ExportResultCode.FAILED,
      error: Object.assign(new Error("endpoint marked down; batch not sent"), { code: ENDPOINT_DOWN_ERROR_CODE }),
    };
  }
  const result = await send();
  await gate.record(result).catch(() => undefined);
  return result;
};
