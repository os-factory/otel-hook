#!/usr/bin/env node
/**
 * Scripted OpenAI Responses mock for the Codex live-lab scenario.
 *
 * Serves POST /v1/responses as SSE (or a JSON body when stream=false) with
 * frozen usage and a deterministic function_call → final-text trajectory.
 * Nothing here talks to a real model.
 *
 * `/last-usage` returns the Codex hook shape (`cached_input_tokens`,
 * `reasoning_output_tokens`, `total_tokens`) so the wrapping harness can
 * attach the same figures Codex would stamp as session-lifetime cumulative
 * totals. Per-request Responses `usage` is the turn delta from the scenario.
 */

import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const readJson = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") {
    return { raw, body: {} };
  }
  try {
    return { raw, body: JSON.parse(raw) };
  } catch {
    return { raw, body: undefined };
  }
};

const asRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;

const walkItems = (value, visit) => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      walkItems(entry, visit);
    }
    return;
  }
  const record = asRecord(value);
  if (record === undefined) {
    return;
  }
  visit(record);
  if (record.content !== undefined) {
    walkItems(record.content, visit);
  }
  if (record.output !== undefined) {
    walkItems(record.output, visit);
  }
  if (record.input !== undefined) {
    walkItems(record.input, visit);
  }
};

const hasToolResult = (body) => {
  let found = false;
  walkItems(body?.input, (item) => {
    const type = typeof item.type === "string" ? item.type : "";
    if (
      type === "function_call_output" ||
      type === "local_shell_call_output" ||
      type === "custom_tool_call_output" ||
      type.includes("tool_result") ||
      type.includes("tool_output")
    ) {
      found = true;
    }
  });
  return found;
};

const collectToolNames = (body) => {
  const names = [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  for (const tool of tools) {
    const record = asRecord(tool);
    if (record === undefined) {
      continue;
    }
    if (typeof record.name === "string") {
      names.push(record.name);
    }
    const inner = asRecord(record.function);
    if (inner !== undefined && typeof inner.name === "string") {
      names.push(inner.name);
    }
  }
  return names;
};

const findToolName = (body, wanted) => {
  const names = collectToolNames(body);
  const lower = wanted.toLowerCase();
  return (
    names.find((name) => name.toLowerCase() === lower) ??
    names.find((name) => name.toLowerCase() === "exec_command") ??
    names.find((name) => name.toLowerCase().includes("shell")) ??
    names.find((name) => name.toLowerCase().includes("read")) ??
    wanted
  );
};

const collectToolParamKeys = (body) => {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools.map((tool) => {
    const record = asRecord(tool) ?? {};
    const parameters = asRecord(record.parameters) ?? asRecord(asRecord(record.function)?.parameters);
    const properties = asRecord(parameters?.properties) ?? {};
    return {
      name: typeof record.name === "string" ? record.name : asRecord(record.function)?.name,
      keys: Object.keys(properties),
    };
  });
};

const toolArgumentsFor = (toolName, widgetPath) => {
  const lower = toolName.toLowerCase();
  if (lower === "exec_command" || lower.endsWith("exec_command")) {
    return {
      cmd: `cat ${JSON.stringify(widgetPath)}`,
      workdir: path.dirname(widgetPath),
    };
  }
  if (lower.includes("shell")) {
    return {
      command: ["cat", widgetPath],
      workdir: path.dirname(widgetPath),
      timeout_ms: 10_000,
    };
  }
  if (lower === "read" || lower.includes("read_file") || lower.includes("read-file")) {
    return { path: widgetPath, file_path: widgetPath };
  }
  return { path: widgetPath, command: ["cat", widgetPath] };
};

const hookUsage = (usage) => ({
  input_tokens: usage.input_tokens,
  cached_input_tokens: usage.cached_input_tokens,
  output_tokens: usage.output_tokens,
  reasoning_output_tokens: usage.reasoning_output_tokens,
  total_tokens: usage.total_tokens,
});

const responsesUsage = (usage) => ({
  input_tokens: usage.input_tokens,
  output_tokens: usage.output_tokens,
  total_tokens: usage.total_tokens,
  input_tokens_details: { cached_tokens: usage.cached_input_tokens },
  output_tokens_details: { reasoning_tokens: usage.reasoning_output_tokens },
});

const streamFunctionCall = ({ model, responseId, toolName, callId, itemId, args, usage }) => {
  const argumentsJson = JSON.stringify(args);
  const item = {
    id: itemId,
    type: "function_call",
    status: "completed",
    name: toolName,
    call_id: callId,
    arguments: argumentsJson,
  };
  const response = {
    id: responseId,
    object: "response",
    created_at: 1_700_000_000,
    status: "completed",
    model,
    output: [item],
    usage: responsesUsage(usage),
  };
  return [
    sse("response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [], usage: null } }),
    sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    }),
    sse("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      output_index: 0,
      delta: argumentsJson,
    }),
    sse("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: 0,
      arguments: argumentsJson,
    }),
    sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }),
    sse("response.completed", { type: "response.completed", response }),
  ].join("");
};

const streamText = ({ model, responseId, text, usage }) => {
  const itemId = "msg_lab_final";
  const item = {
    id: itemId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
  const response = {
    id: responseId,
    object: "response",
    created_at: 1_700_000_001,
    status: "completed",
    model,
    output: [item],
    usage: responsesUsage(usage),
  };
  return [
    sse("response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [], usage: null } }),
    sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    }),
    sse("response.content_part.added", {
      type: "response.content_part.added",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" },
    }),
    sse("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: text,
    }),
    sse("response.output_text.done", {
      type: "response.output_text.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text,
    }),
    sse("response.content_part.done", {
      type: "response.content_part.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text },
    }),
    sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }),
    sse("response.completed", { type: "response.completed", response }),
  ].join("");
};

const jsonFunctionCall = ({ model, responseId, toolName, callId, itemId, args, usage }) => ({
  id: responseId,
  object: "response",
  created_at: 1_700_000_000,
  status: "completed",
  model,
  output: [
    {
      id: itemId,
      type: "function_call",
      status: "completed",
      name: toolName,
      call_id: callId,
      arguments: JSON.stringify(args),
    },
  ],
  usage: responsesUsage(usage),
});

const jsonText = ({ model, responseId, text, usage }) => ({
  id: responseId,
  object: "response",
  created_at: 1_700_000_001,
  status: "completed",
  model,
  output: [
    {
      id: "msg_lab_final",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  ],
  usage: responsesUsage(usage),
});

const isResponsesPath = (url) => {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return pathname.endsWith("/responses");
};

const isModelsPath = (url) => {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return pathname === "/v1/models" || pathname === "/models" || pathname.startsWith("/v1/models/");
};

export const startMockServer = async (options) => {
  const scenario = options.scenario;
  const widgetPath = options.widgetPath;
  const logPath = options.logPath;
  const requests = [];
  let lastUsage = hookUsage(scenario.usage.toolTurn);
  let messageCalls = 0;

  const persistLog = async () => {
    if (logPath === undefined) {
      return;
    }
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, `${requests.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const write = (status, headers, body) => {
      res.writeHead(status, headers);
      res.end(body);
    };

    if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/health" || url.pathname === "/api/hello")) {
      write(200, { "content-type": "application/json" }, JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/last-usage") {
      write(200, { "content-type": "application/json" }, JSON.stringify(lastUsage));
      return;
    }
    if (req.method === "GET" && url.pathname === "/requests") {
      write(200, { "content-type": "application/json" }, JSON.stringify(requests));
      return;
    }
    if (req.method === "GET" && isModelsPath(url)) {
      write(
        200,
        { "content-type": "application/json" },
        JSON.stringify({
          data: [
            {
              id: scenario.model,
              object: "model",
              created: 1_700_000_000,
              owned_by: "lab",
            },
          ],
        }),
      );
      return;
    }

    void (async () => {
      const { raw, body } = await readJson(req);
      const record = {
        method: req.method,
        path: url.pathname,
        stream: body?.stream === true,
        hasToolResult: hasToolResult(body),
        model: typeof body?.model === "string" ? body.model : undefined,
        toolNames: collectToolNames(body),
        toolParams: collectToolParamKeys(body),
        bytes: raw.length,
      };
      requests.push(record);
      await persistLog();

      if (req.method !== "POST" || !isResponsesPath(url)) {
        write(404, { "content-type": "application/json" }, JSON.stringify({ error: { type: "not_found", message: url.pathname } }));
        return;
      }
      if (body === undefined) {
        write(400, { "content-type": "application/json" }, JSON.stringify({ error: { type: "invalid_request_error", message: "invalid json" } }));
        return;
      }

      messageCalls += 1;
      const final = hasToolResult(body) || messageCalls >= 2;
      const usage = final ? scenario.usage.finalTurn : scenario.usage.toolTurn;
      lastUsage = hookUsage(final ? (scenario.usage.cumulativeFinal ?? usage) : usage);
      const model = typeof body.model === "string" && body.model.length > 0 ? body.model : scenario.model;
      const toolName = findToolName(body, scenario.toolName);
      const payload = final
        ? {
            model,
            responseId: "resp_lab_final",
            text: scenario.finalText,
            usage,
          }
        : {
            model,
            responseId: "resp_lab_tool",
            toolName,
            callId: "call_lab_read_01",
            itemId: "fc_lab_read_01",
            args: toolArgumentsFor(toolName, widgetPath),
            usage,
          };

      if (body.stream === false) {
        const json = final ? jsonText(payload) : jsonFunctionCall(payload);
        write(200, { "content-type": "application/json" }, JSON.stringify(json));
        return;
      }

      const stream = final ? streamText(payload) : streamFunctionCall(payload);
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-request-id": `req_lab_${String(messageCalls)}`,
      });
      res.end(stream);
    })().catch((error) => {
      if (!res.headersSent) {
        write(
          500,
          { "content-type": "application/json" },
          JSON.stringify({ error: { type: "api_error", message: error instanceof Error ? error.message : "mock failure" } }),
        );
      } else {
        res.end();
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock server bound to an unexpected address");
  }
  const url = `http://127.0.0.1:${String(address.port)}`;

  return {
    url,
    requests,
    lastUsage: () => lastUsage,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const { readFile } = await import("node:fs/promises");
  const scenario = JSON.parse(
    await readFile(path.join(PLUGIN_ROOT, "scripts", "scenarios", "codex-read-then-ready.json"), "utf8"),
  );
  const mock = await startMockServer({
    scenario,
    widgetPath: process.env.LAB_WIDGET_PATH ?? path.join(process.cwd(), scenario.widgetFileName),
  });
  process.stdout.write(`${mock.url}\n`);
}
