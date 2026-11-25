import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hasPlainPeerRegistration, resolveCodexInvocation, serverPath } from "./lib/codex-cli.mjs";
export { resolveCodexInvocation };
import { loadWorkspacePolicy, resolveWorkspaceDir } from "./lib/workspace-policy.mjs";

import {
  DIRECTIONS,
  buildChildBridgeEnv,
  delegationPrompt,
  evaluateDelegationPolicy,
  getCodexEnvVarsOverrideArg,
} from "./lib/bridge.mjs";
import { createRpcError, startMcpStdioServer, validateToolArguments } from "./lib/mcp.mjs";
import { bridgeStatus } from "./lib/status.mjs";
import {
  MAX_RECENT_EVENTS,
  MAX_STDERR_CHARS,
  clampTimeoutMs,
  createJobRegistry,
  isClosedStdinError,
  terminateProcessTree,
} from "./lib/process.mjs";

const SERVER_NAME = "codex-local";
const SERVER_VERSION = "2.1.0";
const DIRECTION = DIRECTIONS.ANTIGRAVITY_TO_CODEX;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const LAUNCH_TOOL_NAMES = new Set([
  "codex_run",
  "codex_resume",
  "codex_fork",
  "codex_review",
  "codex_spawn",
]);

function buildCodexArgs(mode, params, lastMessagePath, includeAntigravityEnvVars) {
  const args = ["--no-daemon", "-a", "never", "exec", "--ignore-user-config", "-s", params.sandbox];
  const windowsBackend = process.env.AGENT_BRIDGE_CODEX_WINDOWS_SANDBOX;
  if (process.platform === "win32" && windowsBackend !== undefined) {
    if (!["mxc", "elevated", "unelevated"].includes(windowsBackend)) {
      throw createRpcError(-32602, "Invalid AGENT_BRIDGE_CODEX_WINDOWS_SANDBOX.");
    }
    args.push("-c", "windows.sandbox=" + JSON.stringify(windowsBackend));
  }
  // Load only the installed paired server into the delegated CLI.
  const envVarsFlag = includeAntigravityEnvVars
    ? ["-c", "mcp_servers.antigravity-local.command=" + JSON.stringify(process.execPath),
       "-c", "mcp_servers.antigravity-local.args=" + JSON.stringify([serverPath]),
       "-c", getCodexEnvVarsOverrideArg()]
    : [];

  if (mode === "run") {
    args.push(...envVarsFlag);
    args.push("--json", "--color", "never");
    args.push("-C", params.cwd);
    args.push("-o", lastMessagePath);

    if (params.model) args.push("-m", String(params.model));
    for (const dir of params.add_dirs) args.push("--add-dir", dir);
    if (params.skip_git_repo_check) args.push("--skip-git-repo-check");
    if (params.ephemeral) args.push("--ephemeral");
    args.push("-");
    return { args, stdinPrompt: String(params.prompt || "") };
  }

  if (mode === "resume") {
    args.push("resume", ...envVarsFlag, "--json", "-o", lastMessagePath);
    if (params.model) args.push("-m", String(params.model));
    if (params.skip_git_repo_check) args.push("--skip-git-repo-check");
    if (params.ephemeral) args.push("--ephemeral");

    if (params.session_id) {
      args.push(String(params.session_id));
    } else if (params.last) {
      args.push("--last");
    } else {
      throw new Error("Provide either 'session_id' or 'last: true' for codex_resume.");
    }
    args.push("-");
    return { args, stdinPrompt: String(params.prompt || "") };
  }

  if (mode === "fork") {
    if (!params.session_id) {
      throw new Error("'session_id' is required for codex_fork.");
    }
    args.push("fork", ...envVarsFlag, "--json", "-o", lastMessagePath);
    if (params.model) args.push("-m", String(params.model));
    if (params.skip_git_repo_check) args.push("--skip-git-repo-check");
    if (params.ephemeral) args.push("--ephemeral");
    args.push(String(params.session_id), "-");
    return { args, stdinPrompt: String(params.prompt || "") };
  }

  if (mode === "review") {
    args.push("review", ...envVarsFlag, "--json", "-o", lastMessagePath);
    if (params.model) args.push("-m", String(params.model));
    if (params.skip_git_repo_check) args.push("--skip-git-repo-check");
    if (params.title) args.push("--title", String(params.title));

    const hasExplicitTarget = Boolean(
      params.uncommitted || params.base || params.commit
    );
    if (params.uncommitted) args.push("--uncommitted");
    if (params.base) args.push("--base", String(params.base));
    if (params.commit) args.push("--commit", String(params.commit));
    const hasPrompt = Boolean(params.prompt?.trim());
    if (!hasExplicitTarget && !hasPrompt) {
      args.push("--uncommitted");
    }

    if (hasPrompt) {
      args.push("-");
    }
    return { args, stdinPrompt: hasPrompt ? params.prompt : null };
  }

  throw new Error(`Unsupported mode: ${mode}`);
}

function summarizeEvent(evt) {
  if (!evt || typeof evt !== "object") return null;
  if (evt.type === "thread.started") {
    return { type: evt.type, thread_id: evt.thread_id };
  }
  if (evt.type === "turn.started" || evt.type === "turn.completed" || evt.type === "turn.failed") {
    return { type: evt.type, usage: evt.usage, error: evt.error };
  }
  if (evt.type === "error") {
    return { type: evt.type, message: evt.message || evt.error };
  }
  if (evt.type === "item.completed" && evt.item) {
    const item = evt.item;
    if (item.type === "agent_message") {
      return {
        type: "agent_message",
        text_preview: String(item.text || "").slice(0, 240),
      };
    }
    if (item.type === "command_execution") {
      return {
        type: "command_execution",
        command: item.command,
        exit_code: item.exit_code,
        status: item.status,
      };
    }
    if (item.type === "file_change") {
      return {
        type: "file_change",
        changes: item.changes,
        status: item.status,
      };
    }
    return { type: item.type, id: item.id, status: item.status };
  }
  return null;
}

function policy(registry) {
  const evaluation = evaluateDelegationPolicy(DIRECTION, process.env, registry.activeChildren.size);
  if (!evaluation.directionEnabled) {
    registry.cancelAll("Direction disabled by user policy.");
  }
  return evaluation;
}

function readLastMessage(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("Codex final message must be a regular file.");
    if (stat.size > MAX_OUTPUT_BYTES) throw new Error("Codex final message exceeded 4 MiB.");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    return bytes.toString("utf8", 0, offset).trim();
  } finally {
    fs.closeSync(fd);
  }
}

function createRunner(registry, mode, rawParams, evaluation, signal) {
  const policy = loadWorkspacePolicy();
  let cwd, params;
  try {
    cwd = resolveWorkspaceDir(policy, rawParams.cwd);
    const sandbox = rawParams.sandbox ?? "read-only";
    if (sandbox !== "read-only" && !(sandbox === "workspace-write" && policy.allowEdits)) {
      throw new Error("Use read-only, or enable AGENT_BRIDGE_ALLOW_EDITS=true for workspace-write.");
    }
    for (const key of ["model", "session_id", "base", "commit", "title"]) {
      const value = rawParams[key];
      if (value !== undefined && (typeof value !== "string" || !value.trim() || /^\s*-/.test(value))) throw new Error("Invalid " + key + ".");
    }
    if (rawParams.add_dirs !== undefined && (!Array.isArray(rawParams.add_dirs) || mode !== "run")) {
      throw new Error("add_dirs must be an array on a fresh run.");
    }
    const add_dirs = (rawParams.add_dirs ?? []).map(dir => resolveWorkspaceDir(policy, dir, "add_dirs"));
    params = { ...rawParams, cwd, add_dirs, sandbox };
    if (mode === "resume" || mode === "fork") {
      if (params.last && (mode !== "resume" || params.session_id)) throw new Error("Choose a single resume target.");
      const prior = [...registry.jobs.values()].reverse().find(job => job.cwd === cwd && job.status === "completed" &&
        !job.ephemeral && job.session_id && (params.session_id === job.session_id || params.last === true));
      if (!prior) throw new Error("Choose a completed session started by this bridge in the same workspace.");
      if (prior.additionalRoots.length || (prior.sandbox === "workspace-write" && sandbox === "read-only")) {
        throw new Error("The saved session had broader permissions. Start a fresh run with this scope.");
      }
      params.session_id = prior.session_id;
      params.last = false;
    }
  } catch (error) { throw createRpcError(-32602, error.message); }
  if (mode !== "review" && !rawParams.prompt?.trim()) {
    throw createRpcError(-32602, `'prompt' is required for mode '${mode}'.`);
  }

  const jobId = crypto.randomUUID();
  const canReturn = evaluation.config.allow_cycles && evaluation.config.directions[DIRECTIONS.CODEX_TO_ANTIGRAVITY] &&
    evaluation.context.depth + 1 < evaluation.config.max_depth && (evaluation.context.envelope?.remaining_hops ?? Infinity) > 1;
  const includeEnvVars = canReturn && hasPlainPeerRegistration();
  const timeoutMs = clampTimeoutMs(params.timeout_seconds);
  const { env: childEnv, nextDepth, nextChain } = buildChildBridgeEnv(DIRECTION, evaluation);
  childEnv.AGENT_BRIDGE_WORKSPACE_ROOTS = JSON.stringify([cwd, ...params.add_dirs]);
  childEnv.AGENT_BRIDGE_ALLOW_EDITS = String(params.sandbox === "workspace-write");

  const state = {
    job_id: jobId,
    ephemeral: Boolean(params.ephemeral),
    sandbox: params.sandbox,
    additionalRoots: params.add_dirs.filter(dir => dir !== cwd),
    mode,
    cwd,
    status: "running",
    started_at: new Date().toISOString(),
    completed_at: null,
    session_id: params.session_id || null,
    delegation_depth: nextDepth,
    delegation_chain: nextChain,
    exit_code: null,
    signal: null,
    response: "",
    commands: [],
    file_changes: [],
    usage: null,
    errors: [],
    recent_events: [],
    stderr: "",
    pid: null,
    cancel: null,
  };

  let stdoutBuffer = "";
  let stdoutBytes = 0;
  let settled = false;
  let cancelRequested = false;
  let timedOut = false;
  let child = null;
  let timer = null;
  let exitGraceTimer = null;
  let forceKillTimer = null;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mcp-"));
  const lastMessagePath = path.join(tempDir, "last-message.txt");
  const cleanupTempDir = () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup if the filesystem is unavailable.
    }
  };

  const handleJsonLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (!evt || typeof evt !== "object") return;
    if (evt.type === "thread.started" && evt.thread_id) {
      state.session_id = evt.thread_id;
    }
    if (evt.type === "turn.completed" && evt.usage) {
      state.usage = evt.usage;
    }
    if (evt.type === "turn.failed" && evt.error) {
      state.errors.push(
        typeof evt.error === "string" ? evt.error : JSON.stringify(evt.error)
      );
    }
    if (evt.type === "error") {
      state.errors.push(
        typeof evt.message === "string" ? evt.message : JSON.stringify(evt)
      );
    }
    if (evt.type === "item.completed" && evt.item) {
      const item = evt.item;
      if (item.type === "agent_message" && typeof item.text === "string") {
        state.response = item.text;
      } else if (item.type === "command_execution") {
        state.commands.push({
          command: item.command,
          exit_code: item.exit_code,
          status: item.status,
        });
      } else if (item.type === "file_change") {
        state.file_changes.push(item.changes || item);
      }
    }

    const summary = summarizeEvent(evt);
    if (summary) {
      state.recent_events.push(summary);
      if (state.recent_events.length > MAX_RECENT_EVENTS) {
        state.recent_events.shift();
      }
    }
  };

  let stdinPrompt;
  try {
    const prepared = buildCodexArgs(mode, params, lastMessagePath, includeEnvVars);
    stdinPrompt = prepared.stdinPrompt;
    const invocation = resolveCodexInvocation(prepared.args);
    child = spawn(invocation.command, invocation.args, {
      cwd,
      env: childEnv,
      shell: invocation.shell,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    cleanupTempDir();
    throw error;
  }

  const donePromise = new Promise((resolve) => {
    state.pid = child.pid ?? null;
    state.cleanup = cleanupTempDir;

    const finalize = (status, code, exitSignal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (exitGraceTimer) clearTimeout(exitGraceTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);

      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        // ignore stream cleanup errors
      }

      if (stdoutBuffer.trim()) {
        handleJsonLine(stdoutBuffer);
        stdoutBuffer = "";
      }

      if (!state.response) {
        try {
          state.response = readLastMessage(lastMessagePath);
        } catch (error) {
          if (error.code !== "ENOENT") state.errors.push(error.message);
        }
      }
      cleanupTempDir();

      state.status = status === "completed" && state.errors.length ? "failed" : status;
      state.exit_code = code;
      state.signal = exitSignal;
      state.completed_at = new Date().toISOString();
      registry.finish(state, child);
      resolve(state);
    };

    const requestTermination = (targetStatus, reason, force = false) => {
      if (settled || !child) return false;
      state.errors.push(reason);
      if (targetStatus === "cancelled") cancelRequested = true;
      if (targetStatus === "timed_out") timedOut = true;
      terminateProcessTree(child, force);
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          if (!settled) {
            terminateProcessTree(child, true);
            finalize(targetStatus, null, "SIGKILL");
          }
        }, 3000);
        forceKillTimer.unref();
      }
      return true;
    };

    state.cancel = (reason = "Cancelled by caller.") =>
      requestTermination("cancelled", reason);
    const abort = () => requestTermination("cancelled", "MCP request cancelled.", true);
    signal?.addEventListener("abort", abort, { once: true });

    timer = setTimeout(() => {
      requestTermination("timed_out", `Timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }, timeoutMs);
    timer.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdoutBytes > MAX_OUTPUT_BYTES) return;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        stdoutBuffer = "";
        requestTermination("failed", "Codex stdout exceeded 4 MiB.", true);
        return;
      }
      stdoutBuffer += chunk;
      let idx;
      while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, idx);
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        handleJsonLine(line);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (state.stderr.length < MAX_STDERR_CHARS) {
        state.stderr += chunk.slice(0, MAX_STDERR_CHARS - state.stderr.length);
      }
    });

    child.on("error", (err) => {
      state.errors.push(err.message);
      finalize("failed", -1, null);
    });

    const resolveExitStatus = (code) => {
      if (cancelRequested) return "cancelled";
      if (timedOut) return "timed_out";
      return code === 0 && state.errors.length === 0 ? "completed" : "failed";
    };

    child.on("exit", (code, signal) => {
      if (settled || exitGraceTimer) return;
      exitGraceTimer = setTimeout(() => {
        if (settled) return;
        finalize(resolveExitStatus(code), code, signal);
      }, 500);
      exitGraceTimer.unref();
    });

    child.on("close", (code, signal) => {
      finalize(resolveExitStatus(code), code, signal);
    });

    child.stdin.on("error", err => { if (!isClosedStdinError(err)) state.errors.push(err.message); });
    child.stdin.end(stdinPrompt === null ? undefined : delegationPrompt("Google Antigravity", "Codex", stdinPrompt));
  });

  registry.track(state, child);
  return { state, donePromise };
}

function formatStatePayload(state, includeFullOutput = true) {
  const elapsedSeconds = Math.round(
    ((state.completed_at ? Date.parse(state.completed_at) : Date.now()) -
      Date.parse(state.started_at)) /
      1000
  );
  const payload = {
    job_id: state.job_id,
    mode: state.mode,
    status: state.status,
    cwd: state.cwd,
    session_id: state.session_id,
    delegation_depth: state.delegation_depth,
    delegation_chain: state.delegation_chain,
    elapsed_seconds: elapsedSeconds,
    exit_code: state.exit_code,
    usage: state.usage,
    commands_run: state.commands_run ?? state.commands.length,
    file_changes_count: state.file_changes_count ?? state.file_changes.length,
    errors: state.errors,
  };
  if (state.output_pruned) payload.output_pruned = true;
  if (includeFullOutput) {
    payload.response = state.response;
    if (state.commands.length > 0) payload.commands = state.commands.slice(-20);
    if (state.file_changes.length > 0) payload.file_changes = state.file_changes.slice(-20);
    if (state.status !== "completed" && state.stderr.trim()) {
      payload.stderr = state.stderr.trim();
    }
  } else {
    payload.recent_events = state.recent_events.slice(-10);
    if (state.response) {
      payload.response_preview = state.response.slice(0, 400);
    }
  }
  return payload;
}

const ALL_TOOLS = [
  {
    name: "codex_run",
    description:
      "Run a local OpenAI Codex CLI agent synchronously on a task and return its final response, session_id (for resuming/forking), commands executed, and token usage.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          description: "Complete task instructions for the Codex agent.",
        },
        cwd: {
          type: "string",
          description: "Absolute path to the repository or working directory.",
        },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write"],
          description:
            "Defaults to read-only. workspace-write requires AGENT_BRIDGE_ALLOW_EDITS=true.",
        },
        model: {
          type: "string",
          description: "Optional model for the delegated CLI.",
        },
        add_dirs: {
          type: "array",
          items: { type: "string" },
          description: "Optional extra writable directories alongside cwd.",
        },
        skip_git_repo_check: {
          type: "boolean",
          description: "Allow running Codex outside a Git repository.",
        },
        ephemeral: {
          type: "boolean",
          description: "Run without persisting session files to disk.",
        },
        timeout_seconds: {
          type: "number",
          description: "Timeout in seconds (default 600, max 1800).",
        },
      },
      required: ["prompt", "cwd"],
    },
  },
  {
    name: "codex_resume",
    description:
      "Continue an existing local Codex agent session by session_id (or the most recent session with last: true) with follow-up instructions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sandbox: { type: "string", enum: ["read-only", "workspace-write"] },
        session_id: {
          type: "string",
          description: "Session UUID returned from an earlier codex_run or codex_spawn call.",
        },
        last: {
          type: "boolean",
          description: "Resume the most recent local Codex session when session_id is omitted.",
        },
        prompt: {
          type: "string",
          description: "Follow-up prompt for the resumed Codex session.",
        },
        cwd: {
          type: "string",
          description: "Absolute path to the working directory.",
        },
        model: {
          type: "string",
          description: "Optional model override.",
        },
        skip_git_repo_check: {
          type: "boolean",
          description: "Allow running outside a Git repository.",
        },
        timeout_seconds: {
          type: "number",
          description: "Timeout in seconds (default 600, max 1800).",
        },
      },
      required: ["prompt", "cwd"],
    },
  },
  {
    name: "codex_fork",
    description:
      "Fork an existing local Codex session into a new independent thread with new instructions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sandbox: { type: "string", enum: ["read-only", "workspace-write"] },
        session_id: {
          type: "string",
          description: "Existing Codex session UUID to fork.",
        },
        prompt: {
          type: "string",
          description: "Instructions for the forked branch.",
        },
        cwd: {
          type: "string",
          description: "Absolute path to the working directory.",
        },
        model: {
          type: "string",
          description: "Optional model override.",
        },
        skip_git_repo_check: {
          type: "boolean",
          description: "Allow running outside a Git repository.",
        },
        timeout_seconds: {
          type: "number",
          description: "Timeout in seconds (default 600, max 1800).",
        },
      },
      required: ["session_id", "prompt", "cwd"],
    },
  },
  {
    name: "codex_review",
    description:
      "Run a non-interactive code review with local Codex against uncommitted changes, a base branch, or a specific commit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: {
          type: "string",
          description: "Absolute path to the Git repository.",
        },
        uncommitted: {
          type: "boolean",
          description: "Review staged, unstaged, and untracked changes (default if no target is given).",
        },
        base: {
          type: "string",
          description: "Review changes against this base branch (e.g. 'main').",
        },
        commit: {
          type: "string",
          description: "Review changes introduced by a specific commit SHA.",
        },
        title: {
          type: "string",
          description: "Optional title for the review summary.",
        },
        prompt: {
          type: "string",
          description: "Optional custom review focus or checklist.",
        },
        model: {
          type: "string",
          description: "Optional model override.",
        },
        timeout_seconds: {
          type: "number",
          description: "Timeout in seconds (default 600, max 1800).",
        },
      },
      required: ["cwd"],
    },
  },
  {
    name: "codex_spawn",
    description:
      "Start a local Codex agent asynchronously in the background and immediately return a job_id. Use this to orchestrate multiple local Codex agents in parallel or for tasks exceeding ~2 minutes, then poll with codex_job_status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: {
          type: "string",
          enum: ["run", "resume", "fork", "review"],
          description: "Execution mode. Default: 'run'.",
        },
        prompt: {
          type: "string",
          description: "Task instructions (required for run, resume, fork; optional for review).",
        },
        cwd: {
          type: "string",
          description: "Absolute path to the working directory.",
        },
        session_id: {
          type: "string",
          description: "Session UUID when mode is 'resume' or 'fork'.",
        },
        last: {
          type: "boolean",
          description: "Resume most recent session when mode is 'resume' without session_id.",
        },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write"],
          description: "Defaults to read-only. workspace-write requires operator permission.",
        },
        model: { type: "string", description: "Optional model override." },
        add_dirs: { type: "array", items: { type: "string" } },
        uncommitted: { type: "boolean" },
        base: { type: "string" },
        commit: { type: "string" },
        title: { type: "string" },
        skip_git_repo_check: { type: "boolean" },
        ephemeral: { type: "boolean" },
        timeout_seconds: { type: "number" },
      },
      required: ["cwd"],
    },
  },
  {
    name: "codex_job_status",
    description:
      "Inspect the status and output of a background Codex job started by codex_spawn, or list all tracked jobs when job_id is omitted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        job_id: {
          type: "string",
          description: "Specific job_id to inspect. Omit to list all tracked jobs.",
        },
      },
    },
  },
  {
    name: "codex_job_cancel",
    description: "Cancel a currently running background Codex job by job_id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        job_id: {
          type: "string",
          description: "Job ID returned by codex_spawn.",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "codex_status",
    description: "Inspect the Codex CLI, workspace, delegation policy and job capacity.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
];

function getVisibleTools(registry) {
  const evaluation = policy(registry);
  if (!evaluation.directionEnabled) return [];
  if (!evaluation.allowed) {
    return ALL_TOOLS.filter((tool) => !LAUNCH_TOOL_NAMES.has(tool.name));
  }
  return ALL_TOOLS;
}

async function handleToolCall(registry, name, args = {}, signal) {
  const evaluation = policy(registry);
  const launching = LAUNCH_TOOL_NAMES.has(name);
  if (!evaluation.directionEnabled || (launching && !evaluation.allowed)) {
    throw createRpcError(-32602, evaluation.message, {
      reason: evaluation.reason, direction: DIRECTION,
      chain: evaluation.context?.chain ?? [], max_depth: evaluation.config?.max_depth ?? null,
    });
  }
  const tool = ALL_TOOLS.find(tool => tool.name === name);
  if (!tool) throw createRpcError(-32601, `Unknown tool: ${name}`);
  validateToolArguments(tool, args);

  if (launching) {
    const background = name === "codex_spawn";
    const mode = background ? args.mode ?? "run" : name.slice("codex_".length);
    const { state, donePromise } = createRunner(registry, mode, args, evaluation, background ? undefined : signal);
    if (background) {
      const { job_id, status, pid, cwd, delegation_depth, delegation_chain, started_at } = state;
      const job = { job_id, mode, status, pid, cwd, delegation_depth, delegation_chain, started_at };
      return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }] };
    }
    const result = await donePromise;
    return {
      content: [{ type: "text", text: JSON.stringify(formatStatePayload(result, true), null, 2) }],
      isError: result.status !== "completed",
    };
  }
  if (name === "codex_status") return bridgeStatus(resolveCodexInvocation, evaluation, registry, signal);

  if (name === "codex_job_status") {
    if (args.job_id !== undefined) {
      const job = registry.jobs.get(String(args.job_id));
      if (!job) {
        return {
          content: [{ type: "text", text: `Unknown job_id: ${args.job_id}` }],
          isError: true,
        };
      }
      const includeFull = job.status !== "running";
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(formatStatePayload(job, includeFull), null, 2),
          },
        ],
        isError: job.status === "failed" || job.status === "timed_out",
      };
    }

    const list = Array.from(registry.jobs.values()).map((j) =>
      formatStatePayload(j, false)
    );
    return {
      content: [{ type: "text", text: JSON.stringify({ jobs: list }, null, 2) }],
    };
  }

  if (name === "codex_job_cancel") {
    const job = registry.jobs.get(String(args.job_id || ""));
    if (!job) {
      return {
        content: [{ type: "text", text: `Unknown job_id: ${args.job_id}` }],
        isError: true,
      };
    }
    if (job.status !== "running") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { job_id: job.job_id, cancelled: false, status: job.status },
              null,
              2
            ),
          },
        ],
      };
    }
    const cancelled = job.cancel ? job.cancel() : false;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { job_id: job.job_id, cancelled, status: job.status },
            null,
            2
          ),
        },
      ],
    };
  }

  throw createRpcError(-32601, `Unknown tool: ${name}`);
}

export function startCodexMcpServer() {
  const registry = createJobRegistry(() => server.notifyToolsListChangedIfNeeded(getVisibleTools(registry)));
  const server = startMcpStdioServer({
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    getTools: () => getVisibleTools(registry),
    callTool: (name, args, signal) => handleToolCall(registry, name, args, signal),
    onShutdown: () => registry.cancelAll("MCP server shutting down."),
  });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) startCodexMcpServer();
