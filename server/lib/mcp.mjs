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
 * - callTool: (name, args) => Promise<CallToolResult>
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

      if (method === "notifications/initialized" || method === "notifications/cancelled") {
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
        const toolArgs = params?.arguments || {};
        const tools = getTools();
        notifyToolsListChangedIfNeeded(tools);
        const result = await callTool(toolName, toolArgs);
        sendResult(id, result);
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
