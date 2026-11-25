import { readFileSync } from "node:fs";
import readline from "node:readline";

const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

/**
 * Start a zero-dependency JSON-RPC 2.0 MCP stdio server.
 *
 * Options:
 * - serverName: string
 * - serverVersion: string
 * - getTools: () => Array<ToolDefinition>
 * - callTool: (name, args, signal) => Promise<CallToolResult>
 * - onShutdown: () => void
 */
export function startMcpStdioServer({
  serverName,
  serverVersion,
  getTools,
  callTool,
  onShutdown,
}) {
  const serverInfo = { name: serverName, version: serverVersion };
  try {
    const icon = readFileSync(new URL("../../assets/icon-64.png", import.meta.url), "base64");
    serverInfo.icons = [{ src: "data:image/png;base64," + icon, mimeType: "image/png", sizes: ["64x64"] }];
  } catch {
    // A server-only installation can initialize without the optional artwork.
  }
  let initialized = false;
  let lastToolNamesKey = null;
  let inFlightRequests = 0;
  const requests = new Map();
  let stdinClosed = false;

  const log = (message) => {
    process.stderr.write(`[${serverName}] ${message}\n`);
  };

  const sendJsonRpc = (payload) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const sendResult = (id, result) => {
    sendJsonRpc({ jsonrpc: "2.0", id, result });
  };

  const sendError = (id, code, message, data) => {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    sendJsonRpc({ jsonrpc: "2.0", id, error });
  };

  const notifyToolsListChangedIfNeeded = (tools) => {
    const key = tools.map((t) => t.name).join(",");
    if (initialized && lastToolNamesKey !== null && key !== lastToolNamesKey) {
      sendJsonRpc({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
    lastToolNamesKey = key;
  };

  const handleRequest = async (msg) => {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;

    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    try {
      if (method === "initialize") {
        const requestedVersion =
          params && typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : DEFAULT_PROTOCOL_VERSION;
        initialized = true;
        const tools = getTools();
        lastToolNamesKey = tools.map((t) => t.name).join(",");
        sendResult(id, {
          protocolVersion: requestedVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo,
        });
        return;
      }

      if (method === "notifications/cancelled") {
        requests.get(params?.requestId)?.abort();
        return;
      }

      if (method === "notifications/initialized") {
        return;
      }

      if (method === "ping") {
        if (!isNotification) sendResult(id, {});
        return;
      }

      if (method === "tools/list") {
        const tools = getTools();
        notifyToolsListChangedIfNeeded(tools);
        sendResult(id, { tools });
        return;
      }

      if (method === "tools/call") {
        const toolName = params?.name;
        const toolArgs = params?.arguments === undefined ? {} : params.arguments;
        const tools = getTools();
        notifyToolsListChangedIfNeeded(tools);
        if (requests.has(id)) throw createRpcError(-32600, "Duplicate in-flight request ID.");
        const controller = new AbortController();
        if (!isNotification) requests.set(id, controller);
        try {
          const result = await callTool(toolName, toolArgs, controller.signal);
          if (!isNotification) sendResult(id, result);
        } finally {
          if (!isNotification) requests.delete(id);
        }
        return;
      }

      if (!isNotification) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      if (!isNotification) {
        const code =
          typeof err?.rpcCode === "number" ? err.rpcCode : -32603;
        const message = err instanceof Error ? err.message : String(err);
        sendError(id, code, message, err?.rpcData);
      } else {
        log(`Notification error (${method}): ${err}`);
      }
    }
  };

  const doShutdown = () => {
    try {
      onShutdown?.();
    } catch (err) {
      log(`Shutdown error: ${err}`);
    }
  };

  const maybeExitOnStdinClose = () => {
    if (stdinClosed && inFlightRequests === 0) {
      doShutdown();
      process.exit(0);
    }
  };

  process.on("SIGINT", () => {
    doShutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    doShutdown();
    process.exit(0);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      sendError(null, -32700, `Parse error: ${err.message}`);
      return;
    }
    inFlightRequests += 1;
    Promise.resolve(handleRequest(parsed)).finally(() => {
      inFlightRequests -= 1;
      maybeExitOnStdinClose();
    });
  });

  rl.on("close", () => {
    stdinClosed = true;
    maybeExitOnStdinClose();
  });

  return { log, notifyToolsListChangedIfNeeded };
}

export function createRpcError(code, message, data) {
  const err = new Error(message);
  err.rpcCode = code;
  if (data !== undefined) err.rpcData = data;
  return err;
}

export function validateToolArguments(tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw createRpcError(-32602, "Tool arguments must be an object.");
  }
  const { properties, required = [] } = tool.inputSchema;
  for (const key of required) {
    if (!Object.hasOwn(args, key)) throw createRpcError(-32602, `'${key}' is required for ${tool.name}.`);
  }
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(properties, key)) throw createRpcError(-32602, `Unknown parameter '${key}' for ${tool.name}.`);
    const spec = properties[key];
    const type = Array.isArray(value) ? "array" : typeof value;
    const invalidType = spec.type === "integer" ? !Number.isInteger(value)
      : spec.type === "number" ? (typeof value !== "number" || !Number.isFinite(value))
      : spec.type && (type !== spec.type || value === null);
    if (invalidType || (spec.enum && !spec.enum.includes(value)) || (spec.const !== undefined && value !== spec.const)) {
      throw createRpcError(-32602, `Invalid '${key}' for ${tool.name}.`);
    }
  }
}
