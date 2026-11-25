import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { buildChildBridgeEnv, DIRECTIONS, evaluateDelegationPolicy } from "./lib/bridge.mjs";
import { createRpcError, startMcpStdioServer } from "./lib/mcp.mjs";
import {
  createJobRegistry, DEFAULT_TIMEOUT_SECONDS, findWindowsCommand, MAX_RECENT_EVENTS,
  MAX_STDERR_CHARS, MAX_TIMEOUT_SECONDS, terminateProcessTree, validateAbsoluteDir,
  windowsBatchInvocation,
} from "./lib/process.mjs";

const direction = DIRECTIONS.CODEX_TO_ANTIGRAVITY;

export function resolveAgyInvocation(agyArgs, env = process.env) {
  const windows = process.platform === "win32";
  const defaults = windows ? [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "agy", "bin", "agy.exe"),
    env.USERPROFILE && path.join(env.USERPROFILE, ".local", "bin", "agy.exe"),
  ] : [
    path.join(env.HOME || os.homedir(), ".local", "bin", "agy"),
    "/opt/homebrew/bin/agy", "/usr/local/bin/agy",
  ];
  const found = [env.AGY_BIN, ...defaults].find(
    (file) => file && fs.statSync(file, { throwIfNoEntry: false })?.isFile()
  );
  const command = found ? path.resolve(found) : windows ? findWindowsCommand("agy", env) : "agy";
  if (windows && /\.(cmd|bat)$/i.test(command)) return windowsBatchInvocation(command, agyArgs);
  if (/\.[cm]?js$/i.test(command)) {
    return { command: process.execPath, args: [command, ...agyArgs], shell: false };
  }
  return { command, args: agyArgs, shell: false };
}

const launchSchema = {
  type: "object",
  required: ["prompt", "cwd"],
  properties: {
    prompt: { type: "string", description: "Task instructions for Antigravity." },
    cwd: { type: "string", description: "Absolute working directory." },
    resume: {
      type: "object",
      properties: { conversation_id: { type: "string", minLength: 1 }, continue_last: { const: true } },
      oneOf: [{ required: ["conversation_id"] }, { required: ["continue_last"] }],
      additionalProperties: false,
    },
    model: { type: "string" },
    agent: { type: "string" },
    effort: { type: "string" },
    mode: { type: "string", description: "Antigravity execution mode." },
    add_dirs: { type: "array", items: { type: "string" } },
    sandbox: { type: "boolean", default: true },
    disable_slash_commands: { type: "boolean", default: true },
    json_schema: { type: "object", description: "JSON Schema for the structured output." },
    timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SECONDS, default: DEFAULT_TIMEOUT_SECONDS },
  },
};
const jobSchema = { type: "object", properties: { job_id: { type: "string" } } };
const launchTools = [
  { name: "antigravity_run", description: "Run a local Antigravity task and return its response and conversation ID.", inputSchema: launchSchema },
  { name: "antigravity_spawn", description: "Start a background Antigravity task and return its job ID.", inputSchema: launchSchema },
];
const jobTools = [
  { name: "antigravity_job_status", description: "Inspect a job, or list tracked jobs when job_id is omitted.", inputSchema: jobSchema },
  { name: "antigravity_job_cancel", description: "Cancel a running Antigravity job and its child processes.", inputSchema: { ...jobSchema, required: ["job_id"] } },
];

function buildArgs(params, seconds) {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  if (typeof params.prompt !== "string" || !params.prompt.trim()) throw new Error("A prompt is required.");
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
    throw new Error("timeout_seconds must be an integer between 1 and " + MAX_TIMEOUT_SECONDS + ".");
  }
  if (params.resume !== undefined) {
    const resume = params.resume;
    if (resume && Object.keys(resume).length === 1 && typeof resume.conversation_id === "string" && resume.conversation_id.trim()) {
      args.push("--conversation", resume.conversation_id);
    } else if (resume && Object.keys(resume).length === 1 && resume.continue_last === true) {
      args.push("--continue");
    } else {
      throw new Error("resume requires either conversation_id or continue_last: true.");
    }
  }
  for (const key of ["model", "agent", "effort", "mode"]) {
    if (params[key] === undefined) continue;
    if (typeof params[key] !== "string" || !params[key].trim()) throw new Error(key + " must be a non-empty string.");
    args.push("--" + key, params[key]);
  }
  if (params.add_dirs !== undefined) {
    if (!Array.isArray(params.add_dirs)) throw new Error("add_dirs must be an array.");
    for (const dir of params.add_dirs) args.push("--add-dir", validateAbsoluteDir(dir, "add_dirs"));
  }
  for (const key of ["sandbox", "disable_slash_commands"]) {
    if (params[key] !== undefined && typeof params[key] !== "boolean") throw new Error(key + " must be a boolean.");
    if (params[key] !== false) args.push("--" + key.replaceAll("_", "-"));
  }
  if (params.json_schema !== undefined) {
    if (!params.json_schema || typeof params.json_schema !== "object" || Array.isArray(params.json_schema)) {
      throw new Error("json_schema must be an object.");
    }
    args.push("--json-schema", JSON.stringify(params.json_schema));
  }
  args.push("--print-timeout", seconds + "s");
  return args;
}

function recordEvent(job, line) {
  if (!line.trim()) return;
  let event;
  try { event = JSON.parse(line); } catch { return; }
  const kind = event?.event;
  if (!["init", "step_update", "result"].includes(kind)) return;
  const data = event[kind] ?? {};
  job.conversation_id = data.conversation_id ?? event.conversation_id ?? job.conversation_id;
  job.result_status = kind === "result" ? data.status : null;
  const summary = { event: kind };
  if (kind === "step_update") {
    const { step_index, step_type, state, tool_name, text_delta } = data;
    Object.assign(summary, { step_index, step_type, state, tool_name });
    if (step_type === "agent_response" && typeof text_delta === "string") {
      job.response += text_delta;
      summary.text_preview = text_delta.slice(0, 240);
    }
  } else if (kind === "result") {
    summary.status = data.status;
    if (typeof data.response === "string" && data.response.length) job.response = data.response;
    job.structured_output = data.structured_output ?? null;
    job.finished_reason = data.finished_reason;
    if (data.error) job.errors.push(typeof data.error === "string" ? data.error : JSON.stringify(data.error));
  }
  job.usage = data.usage ?? job.usage;
  job.recent_events.push(summary);
  if (job.recent_events.length > MAX_RECENT_EVENTS) job.recent_events.shift();
}

function launch(registry, params, evaluation) {
  const seconds = params.timeout_seconds === undefined ? DEFAULT_TIMEOUT_SECONDS : params.timeout_seconds;
  let cwd, args;
  try {
    cwd = validateAbsoluteDir(params.cwd);
    args = buildArgs(params, seconds);
  } catch (err) {
    throw createRpcError(-32602, err.message);
  }
  const { env, nextDepth, nextChain } = buildChildBridgeEnv(direction, evaluation);
  const invocation = resolveAgyInvocation(args, env);
  const child = spawn(invocation.command, invocation.args, {
    cwd, env, shell: false, windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    stdio: "pipe", windowsHide: true, detached: process.platform !== "win32",
  });
  const job = {
    job_id: randomUUID(), status: "running", pid: child.pid ?? null, cwd,
    started_at: new Date().toISOString(), completed_at: null, exit_code: null, signal: null,
    delegation_depth: nextDepth, delegation_chain: nextChain,
    conversation_id: params.resume?.conversation_id ?? null,
    response: "", result_status: null, structured_output: null, usage: null,
    recent_events: [], errors: [], stderr: "",
  };
  registry.jobs.set(job.job_id, job);
  registry.activeChildren.add(child);

  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => recordEvent(job, line));
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    job.stderr += chunk.slice(0, MAX_STDERR_CHARS - job.stderr.length);
  });
  let stopping, forceTimer, drainTimer;
  function stop(status, reason) {
    if (stopping || job.status !== "running") return false;
    stopping = status;
    job.errors.push(reason);
    terminateProcessTree(child);
    forceTimer = setTimeout(() => terminateProcessTree(child, true), 3000);
    return true;
  }
  job.cancel = (reason = "Cancelled by caller.") => stop("cancelled", reason);
  const watchdog = setTimeout(() => stop("timed_out", "Timed out after " + seconds + "s."), seconds * 1000);
  child.stdin.on("error", (err) => job.errors.push(err.message));
  child.on("error", (err) => job.errors.push(err.message));
  child.once("exit", () => {
    // A descendant can hold inherited pipes open after the CLI exits.
    drainTimer = setTimeout(() => {
      terminateProcessTree(child, true);
      child.stdout.destroy();
      child.stderr.destroy();
    }, 500);
  });
  const done = new Promise((resolve) => child.once("close", (code, signal) => {
    clearTimeout(watchdog);
    clearTimeout(forceTimer);
    clearTimeout(drainTimer);
    if (stopping && process.platform !== "win32") terminateProcessTree(child, true);
    registry.activeChildren.delete(child);
    delete job.cancel;
    job.exit_code = code;
    job.signal = signal;
    job.completed_at = new Date().toISOString();
    if (stopping) job.status = stopping;
    else if (job.finished_reason === "print_timeout") job.status = "timed_out";
    else if (job.result_status === "SUCCESS" && code === 0 && !job.errors.length) job.status = "completed";
    else {
      job.status = "failed";
      if (!job.errors.length) job.errors.push(job.result_status
        ? "Antigravity result " + job.result_status + ", exit code " + code + "."
        : "Antigravity exited without a terminal result.");
    }
    resolve(job);
  }));
  child.stdin.end(JSON.stringify({ event: "user", message: { content: params.prompt } }) + "\n");
  return { job, done };
}

function reply(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

function summary(job) {
  const { response, stderr, structured_output, cancel, ...rest } = job;
  return { ...rest, response_preview: response.slice(0, 400) };
}

export function startAntigravityMcpServer() {
  const registry = createJobRegistry();
  function policy() {
    const evaluation = evaluateDelegationPolicy(direction);
    if (!evaluation.directionEnabled) registry.cancelAll("Direction disabled by user policy.");
    return evaluation;
  }
  return startMcpStdioServer({
    serverName: "antigravity-local", serverVersion: "2.0.0",
    getTools() {
      const evaluation = policy();
      if (!evaluation.directionEnabled) return [];
      return evaluation.allowed ? [...launchTools, ...jobTools] : jobTools;
    },
    async callTool(name, args) {
      const evaluation = policy();
      const launching = launchTools.some((tool) => tool.name === name);
      if (!evaluation.directionEnabled || (launching && !evaluation.allowed)) {
        throw createRpcError(-32602, evaluation.message, {
          reason: evaluation.reason, direction, chain: evaluation.context?.chain ?? [],
          max_depth: evaluation.config?.max_depth ?? null,
        });
      }
      if (launching) {
        const { job, done } = launch(registry, args, evaluation);
        if (name === "antigravity_spawn") return reply(summary(job));
        await done;
        return reply(job, job.status !== "completed");
      }
      if (name === "antigravity_job_status" && args.job_id === undefined) {
        return reply({ jobs: Array.from(registry.jobs.values(), summary) });
      }
      if (!jobTools.some((tool) => tool.name === name)) throw createRpcError(-32601, "Unknown tool: " + name);
      const job = registry.jobs.get(args.job_id);
      if (!job) return { content: [{ type: "text", text: "Unknown job_id: " + args.job_id }], isError: true };
      if (name === "antigravity_job_cancel") {
        return reply({ job_id: job.job_id, cancelled: job.cancel?.() ?? false, status: job.status });
      }
      return reply(job, job.status === "failed" || job.status === "timed_out");
    },
    onShutdown: () => registry.cancelAll("MCP server shutting down."),
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) startAntigravityMcpServer();
