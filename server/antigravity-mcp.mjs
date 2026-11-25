import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { buildChildBridgeEnv, delegationPrompt, DIRECTIONS, evaluateDelegationPolicy } from "./lib/bridge.mjs";
import { createRpcError, startMcpStdioServer, validateToolArguments } from "./lib/mcp.mjs";
import { bridgeStatus } from "./lib/status.mjs";
import { loadWorkspacePolicy, resolveWorkspaceDir } from "./lib/workspace-policy.mjs";
import {
  cliInvocation, configuredFile, createJobRegistry, DEFAULT_TIMEOUT_SECONDS, findWindowsCommand, MAX_RECENT_EVENTS,
  isClosedStdinError, MAX_STDERR_CHARS, MAX_TIMEOUT_SECONDS, terminateProcessTree,
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
  const configured = configuredFile(env.AGY_BIN, "AGY_BIN");
  if (configured) return cliInvocation(configured, agyArgs, "AGY_BIN");
  const found = defaults.find(
    (file) => file && path.isAbsolute(file) && fs.statSync(file, { throwIfNoEntry: false })?.isFile()
  );
  const command = found ? path.resolve(found) : windows ? findWindowsCommand("agy", env) : "agy";
  return cliInvocation(command, agyArgs, found ? "platform installation" : "PATH");
}

const launchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["prompt", "cwd"],
  properties: {
    prompt: { type: "string", description: "Task instructions for Antigravity." },
    cwd: { type: "string", description: "Absolute working directory." },
    model: { type: "string" },
    effort: { type: "string" },
    mode: { enum: ["plan", "accept-edits"], default: "plan" },
    add_dirs: { type: "array", items: { type: "string" } },
    sandbox: { const: true },
    disable_slash_commands: { const: true },
    json_schema: { type: "object", description: "JSON Schema for the structured output." },
    timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SECONDS, default: DEFAULT_TIMEOUT_SECONDS },
  },
};
const jobSchema = { type: "object", additionalProperties: false, properties: { job_id: { type: "string" } } };
const launchTools = [
  { name: "antigravity_run", description: "Run a local Antigravity task and return its response and conversation ID.", inputSchema: launchSchema },
  { name: "antigravity_spawn", description: "Start a background Antigravity task and return its job ID.", inputSchema: launchSchema },
];
const jobTools = [
  { name: "antigravity_job_status", description: "Inspect a job, or list tracked jobs when job_id is omitted.", inputSchema: jobSchema },
  { name: "antigravity_job_cancel", description: "Cancel a running Antigravity job and its child processes.", inputSchema: { ...jobSchema, required: ["job_id"] } },
  { name: "antigravity_status", description: "Inspect the Antigravity CLI, workspace, delegation policy and job capacity.",
    annotations: { readOnlyHint: true }, inputSchema: { type: "object", additionalProperties: false, properties: {} } },
];

function buildArgs(params, seconds, policy) {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  if (typeof params.prompt !== "string" || !params.prompt.trim()) throw new Error("A prompt is required.");
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
    throw new Error("timeout_seconds must be an integer between 1 and " + MAX_TIMEOUT_SECONDS + ".");
  }
  if (!policy.allowEdits) throw new Error("Antigravity requires AGENT_BRIDGE_ALLOW_EDITS=true because its CLI can edit the workspace.");
  const mode = params.mode ?? "plan";
  if (!["plan", "accept-edits"].includes(mode)) throw new Error("Choose plan or accept-edits.");
  for (const key of ["model", "effort"]) {
    if (params[key] === undefined) continue;
    if (typeof params[key] !== "string" || !params[key].trim() || /^\s*-/.test(params[key])) throw new Error("Invalid " + key + ".");
    args.push("--" + key, params[key]);
  }
  args.push("--mode", mode);
  for (const dir of params.add_dirs) args.push("--add-dir", dir);
  for (const key of ["sandbox", "disable_slash_commands"]) {
    if (params[key] !== undefined && params[key] !== true) throw new Error(key + " must be true.");
    args.push("--" + key.replaceAll("_", "-"));
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

function launch(registry, params, evaluation, signal) {
  const seconds = params.timeout_seconds === undefined ? DEFAULT_TIMEOUT_SECONDS : params.timeout_seconds;
  let cwd, args;
  try {
    const policy = loadWorkspacePolicy();
    cwd = resolveWorkspaceDir(policy, params.cwd);
    if (params.add_dirs !== undefined && !Array.isArray(params.add_dirs)) throw new Error("add_dirs must be an array.");
    params = { ...params, add_dirs: (params.add_dirs ?? []).map(dir => resolveWorkspaceDir(policy, dir, "add_dirs")) };
    args = buildArgs(params, seconds, policy);
  } catch (err) {
    throw createRpcError(-32602, err.message);
  }
  const { env, nextDepth, nextChain } = buildChildBridgeEnv(direction, evaluation);
  env.AGENT_BRIDGE_WORKSPACE_ROOTS = JSON.stringify([cwd, ...params.add_dirs]);
  if ((params.mode ?? "plan") === "plan") env.AGENT_BRIDGE_ALLOW_EDITS = "false";
  const invocation = resolveAgyInvocation(args, env);
  const child = spawn(invocation.command, invocation.args, {
    cwd, env, shell: false,
    stdio: "pipe", windowsHide: true, detached: process.platform !== "win32",
  });
  const job = {
    job_id: randomUUID(), status: "running", pid: child.pid ?? null, cwd,
    started_at: new Date().toISOString(), completed_at: null, exit_code: null, signal: null,
    delegation_depth: nextDepth, delegation_chain: nextChain,
    conversation_id: null,
    response: "", result_status: null, structured_output: null, usage: null,
    recent_events: [], errors: [], stderr: "",
  };

  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => recordEvent(job, line));
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    job.stderr += chunk.slice(0, MAX_STDERR_CHARS - job.stderr.length);
  });
  let stopping, forceTimer, drainTimer;
  function stop(status, reason, force = false) {
    if (stopping || job.status !== "running") return false;
    stopping = status;
    job.errors.push(reason);
    terminateProcessTree(child, force);
    forceTimer = setTimeout(() => terminateProcessTree(child, true), 3000).unref();
    return true;
  }
  job.cancel = (reason = "Cancelled by caller.") => stop("cancelled", reason);
  const abort = () => stop("cancelled", "MCP request cancelled.", true);
  signal?.addEventListener("abort", abort, { once: true });
  const watchdog = setTimeout(() => stop("timed_out", "Timed out after " + seconds + "s."), seconds * 1000).unref();
  child.stdin.on("error", err => { if (!isClosedStdinError(err)) job.errors.push(err.message); });
  child.on("error", (err) => job.errors.push(err.message));
  child.once("exit", () => {
    // A descendant can hold inherited pipes open after the CLI exits.
    drainTimer = setTimeout(() => {
      terminateProcessTree(child, true);
      child.stdout.destroy();
      child.stderr.destroy();
    }, 500).unref();
  });
  const done = new Promise((resolve) => child.once("close", (code, exitSignal) => {
    clearTimeout(watchdog);
    clearTimeout(forceTimer);
    clearTimeout(drainTimer);
    if (stopping && process.platform !== "win32") terminateProcessTree(child, true);
    signal?.removeEventListener("abort", abort);
    job.exit_code = code;
    job.signal = exitSignal;
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
    registry.finish(job, child);
    resolve(job);
  }));
  const content = delegationPrompt("Codex", "Google Antigravity", params.prompt);
  child.stdin.end(JSON.stringify({ event: "user", message: { content } }) + "\n");
  registry.track(job, child);
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
  const registry = createJobRegistry(() => server.notifyToolsListChangedIfNeeded(getTools()));
  function policy() {
    const evaluation = evaluateDelegationPolicy(direction, process.env, registry.activeChildren.size);
    if (!evaluation.directionEnabled) registry.cancelAll("Direction disabled by user policy.");
    return evaluation;
  }
  function getTools() {
    const evaluation = policy();
    if (!evaluation.directionEnabled) return [];
    return evaluation.allowed ? [...launchTools, ...jobTools] : jobTools;
  }
  const server = startMcpStdioServer({
    serverName: "antigravity-local", serverVersion: "2.1.0", getTools,
    async callTool(name, args, signal) {
      const evaluation = policy();
      const launching = launchTools.some((tool) => tool.name === name);
      if (!evaluation.directionEnabled || (launching && !evaluation.allowed)) {
        throw createRpcError(-32602, evaluation.message, {
          reason: evaluation.reason, direction, chain: evaluation.context?.chain ?? [],
          max_depth: evaluation.config?.max_depth ?? null,
        });
      }
      const tool = [...launchTools, ...jobTools].find(tool => tool.name === name);
      if (!tool) throw createRpcError(-32601, "Unknown tool: " + name);
      validateToolArguments(tool, args);
      if (launching) {
        const { job, done } = launch(registry, args, evaluation, name === "antigravity_run" ? signal : undefined);
        if (name === "antigravity_spawn") return reply(summary(job));
        await done;
        return reply(job, job.status !== "completed");
      }
      if (name === "antigravity_status") return bridgeStatus(resolveAgyInvocation, evaluation, registry, signal);
      if (name === "antigravity_job_status" && args.job_id === undefined) {
        return reply({ jobs: Array.from(registry.jobs.values(), summary) });
      }
      const job = registry.jobs.get(args.job_id);
      if (!job) return { content: [{ type: "text", text: "Unknown job_id: " + args.job_id }], isError: true };
      if (name === "antigravity_job_cancel") {
        return reply({ job_id: job.job_id, cancelled: job.cancel?.() ?? false, status: job.status });
      }
      return reply(job, job.status === "failed" || job.status === "timed_out");
    },
    onShutdown: () => registry.cancelAll("MCP server shutting down."),
  });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) startAntigravityMcpServer();
