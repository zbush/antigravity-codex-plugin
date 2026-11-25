import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DIRECTIONS,
  buildChildBridgeEnv,
  evaluateDelegationPolicy,
  getCodexEnvVarsOverrideArg,
  hasCodexAntigravityMcpConfigured,
} from "./lib/bridge.mjs";
import { createRpcError, startMcpStdioServer } from "./lib/mcp.mjs";
import {
  MAX_RECENT_EVENTS,
  MAX_STDERR_CHARS,
  clampTimeoutMs,
  findWindowsCommand,
  createJobRegistry,
  terminateProcessTree,
  validateAbsoluteDir,
  windowsBatchInvocation,
} from "./lib/process.mjs";

const SERVER_NAME = "codex-local";
const SERVER_VERSION = "2.0.0";
const DIRECTION = DIRECTIONS.ANTIGRAVITY_TO_CODEX;

const LAUNCH_TOOL_NAMES = new Set([
  "codex_run",
  "codex_resume",
  "codex_fork",
  "codex_review",
  "codex_spawn",
]);

const registry = createJobRegistry();

export function resolveCodexInvocation(codexArgs, env = process.env) {
  const configuredBin = env.CODEX_BIN;
  if (configuredBin && fs.existsSync(configuredBin)) {
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(configuredBin)) {
      return windowsBatchInvocation(configuredBin, codexArgs);
    }
    return {
      command: configuredBin,
      args: codexArgs,
      shell: false,
    };
  }

  const configuredJs = env.CODEX_CLI_JS;
  if (configuredJs && fs.existsSync(configuredJs)) {
    return {
      command: process.execPath,
      args: [configuredJs, ...codexArgs],
      shell: false,
    };
  }

  const nodeDir = path.dirname(process.execPath);
  const npmPrefix = env.NPM_CONFIG_PREFIX || env.npm_config_prefix;
  const candidateJsPaths = [
    path.join(nodeDir, "node_modules", "@openai", "codex", "bin", "codex.js"),
    path.resolve(nodeDir, "..", "lib", "node_modules", "@openai", "codex", "bin", "codex.js"),
    ...(npmPrefix
      ? [
          path.join(npmPrefix, "node_modules", "@openai", "codex", "bin", "codex.js"),
          path.join(npmPrefix, "lib", "node_modules", "@openai", "codex", "bin", "codex.js"),
        ]
      : []),
    ...(process.platform === "win32" && env.APPDATA
      ? [path.join(env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")]
      : []),
  ];

  for (const candidate of candidateJsPaths) {
    if (fs.existsSync(candidate)) {
      return {
        command: process.execPath,
        args: [candidate, ...codexArgs],
        shell: false,
      };
    }
  }

  if (process.platform === "win32") {
    const command = findWindowsCommand("codex", env);
    if (/\.(cmd|bat)$/i.test(command)) return windowsBatchInvocation(command, codexArgs);
    return { command, args: codexArgs, shell: false };
  }

  return {
    command: "codex",
    args: codexArgs,
    shell: false,
  };
}

function buildCodexArgs(mode, params, lastMessagePath, includeAntigravityEnvVars) {
  const args = ["exec"];
  const envVarsFlag = includeAntigravityEnvVars
    ? ["-c", getCodexEnvVarsOverrideArg()]
    : [];

  if (mode === "run") {
    args.push(...envVarsFlag);
    args.push("--json", "--color", "never");
    args.push("-C", params.cwd);
    args.push("-o", lastMessagePath);

    const sandbox = params.sandbox || "workspace-write";
    args.push("-s", sandbox);

    if (params.model) args.push("-m", String(params.model));
    if (params.profile) args.push("-p", String(params.profile));
    if (params.worktree) args.push("--worktree");
    if (Array.isArray(params.add_dirs)) {
      for (const dir of params.add_dirs) {
        if (typeof dir === "string" && dir.trim()) {
          args.push("--add-dir", validateAbsoluteDir(dir, "add_dirs"));
        }
      }
    }
    if (params.skip_git_repo_check) args.push("--skip-git-repo-check");
    if (params.ephemeral) args.push("--ephemeral");
    args.push("-");
    return { args, stdinPrompt: String(params.prompt || "") };
  }

  if (mode === "resume") {
    args.push("resume", ...envVarsFlag, "--json", "-o", lastMessagePath);
    if (params.model) args.push("-m", String(params.model));
    if (params.worktree) args.push("--worktree");
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
    if (params.worktree) args.push("--worktree");
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
    if (!hasExplicitTarget && !params.prompt) {
      args.push("--uncommitted");
    }

    const hasPrompt = typeof params.prompt === "string" && params.prompt.trim().length > 0;
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

function assertLaunchAllowed() {
  const evaluation = evaluateDelegationPolicy(DIRECTION);
  if (!evaluation.directionEnabled) {
    registry.cancelAll("Direction disabled by user policy.");
  }
  if (!evaluation.allowed) {
    throw createRpcError(-32602, evaluation.message, {
      reason: evaluation.reason,
      direction: DIRECTION,
      chain: evaluation.context?.chain ?? [],
      max_depth: evaluation.config?.max_depth ?? null,
    });
  }
  return evaluation;
}

function createRunner(mode, rawParams, evaluation) {
  const cwd = validateAbsoluteDir(rawParams.cwd, "cwd");
  if ((mode === "run" || mode === "resume" || mode === "fork") && !String(rawParams.prompt || "").trim()) {
    throw new Error(`'prompt' is required for mode '${mode}'.`);
  }

  const jobId = crypto.randomUUID().slice(0, 8);
  const lastMessagePath = path.join(
    os.tmpdir(),
    `codex-mcp-last-${jobId}-${Date.now()}.txt`
  );
  const params = { ...rawParams, cwd };
  const includeEnvVars = hasCodexAntigravityMcpConfigured();
  const { args, stdinPrompt } = buildCodexArgs(mode, params, lastMessagePath, includeEnvVars);
  const invocation = resolveCodexInvocation(args);
  const timeoutMs = clampTimeoutMs(params.timeout_seconds);
  const { env: childEnv, nextDepth, nextChain } = buildChildBridgeEnv(DIRECTION, evaluation);

  const state = {
    job_id: jobId,
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
    messages: [],
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
  let settled = false;
  let cancelRequested = false;
  let timedOut = false;
  let child = null;
  let timer = null;
  let exitGraceTimer = null;
  let forceKillTimer = null;

  const cleanupTempFile = () => {
    try {
      if (fs.existsSync(lastMessagePath)) fs.unlinkSync(lastMessagePath);
    } catch {
      // ignore temp cleanup failure
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
        state.messages.push(item.text);
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

  const donePromise = new Promise((resolve) => {
    child = spawn(invocation.command, invocation.args, {
      cwd,
      env: childEnv,
      shell: invocation.shell,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    state.pid = child.pid ?? null;
    registry.activeChildren.add(child);

    const finalize = (status, code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (exitGraceTimer) clearTimeout(exitGraceTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      registry.activeChildren.delete(child);

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

      if (!state.response && fs.existsSync(lastMessagePath)) {
        try {
          state.response = fs.readFileSync(lastMessagePath, "utf8").trim();
        } catch {
          // ignore read errors
        }
      }
      cleanupTempFile();

      state.status = status;
      state.exit_code = code;
      state.signal = signal;
      state.completed_at = new Date().toISOString();
      resolve(state);
    };

    const requestTermination = (targetStatus, reason) => {
      if (settled || !child) return false;
      state.errors.push(reason);
      if (targetStatus === "cancelled") cancelRequested = true;
      if (targetStatus === "timed_out") timedOut = true;
      terminateProcessTree(child, false);
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

    timer = setTimeout(() => {
      requestTermination("timed_out", `Timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }, timeoutMs);
    timer.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
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

    if (stdinPrompt !== null) {
      child.stdin.write(stdinPrompt);
    }
    child.stdin.end();
  });

  registry.jobs.set(jobId, state);
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
    commands_run: state.commands.length,
    file_changes_count: state.file_changes.length,
    errors: state.errors,
  };
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
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description:
            "Sandbox policy for Codex commands. Default: 'workspace-write'. Use 'read-only' for audits and analysis.",
        },
        model: {
          type: "string",
          description: "Optional model override (defaults to user's ~/.codex/config.toml).",
        },
        profile: {
          type: "string",
          description: "Optional Codex configuration profile name.",
        },
        worktree: {
          type: "boolean",
          description:
            "Run Codex in a new managed Git worktree to isolate edits from the main working tree.",
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
      properties: {
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
        worktree: {
          type: "boolean",
          description: "Run in a managed Git worktree.",
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
      properties: {
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
        worktree: {
          type: "boolean",
          description: "Run the forked session in a new managed Git worktree.",
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
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description: "Sandbox policy when mode is 'run'. Default: 'workspace-write'.",
        },
        model: { type: "string", description: "Optional model override." },
        profile: { type: "string", description: "Optional Codex profile." },
        worktree: {
          type: "boolean",
          description: "Recommended when spawning multiple parallel editing Codex agents in the same repo.",
        },
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
      properties: {
        job_id: {
          type: "string",
          description: "Job ID returned by codex_spawn.",
        },
      },
      required: ["job_id"],
    },
  },
];

function getVisibleTools() {
  const evaluation = evaluateDelegationPolicy(DIRECTION);
  if (!evaluation.directionEnabled) {
    registry.cancelAll("Direction disabled by user policy.");
    return [];
  }
  if (!evaluation.allowed) {
    // At depth/cycle limit: hide launch tools, keep inspection/cancellation tools.
    return ALL_TOOLS.filter((tool) => !LAUNCH_TOOL_NAMES.has(tool.name));
  }
  return ALL_TOOLS;
}

async function handleToolCall(name, args = {}) {
  if (LAUNCH_TOOL_NAMES.has(name)) {
    const evaluation = assertLaunchAllowed();

    if (name === "codex_run") {
      const { donePromise } = createRunner("run", args, evaluation);
      const result = await donePromise;
      return {
        content: [{ type: "text", text: JSON.stringify(formatStatePayload(result, true), null, 2) }],
        isError: result.status !== "completed",
      };
    }

    if (name === "codex_resume") {
      const { donePromise } = createRunner("resume", args, evaluation);
      const result = await donePromise;
      return {
        content: [{ type: "text", text: JSON.stringify(formatStatePayload(result, true), null, 2) }],
        isError: result.status !== "completed",
      };
    }

    if (name === "codex_fork") {
      const { donePromise } = createRunner("fork", args, evaluation);
      const result = await donePromise;
      return {
        content: [{ type: "text", text: JSON.stringify(formatStatePayload(result, true), null, 2) }],
        isError: result.status !== "completed",
      };
    }

    if (name === "codex_review") {
      const { donePromise } = createRunner("review", args, evaluation);
      const result = await donePromise;
      return {
        content: [{ type: "text", text: JSON.stringify(formatStatePayload(result, true), null, 2) }],
        isError: result.status !== "completed",
      };
    }

    if (name === "codex_spawn") {
      const mode = args.mode || "run";
      const { state } = createRunner(mode, args, evaluation);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                job_id: state.job_id,
                mode: state.mode,
                status: state.status,
                pid: state.pid,
                cwd: state.cwd,
                delegation_depth: state.delegation_depth,
                delegation_chain: state.delegation_chain,
                started_at: state.started_at,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }

  // Non-launch tools (status/cancel): reject only if the entire direction is disabled.
  const evaluation = evaluateDelegationPolicy(DIRECTION);
  if (!evaluation.directionEnabled) {
    registry.cancelAll("Direction disabled by user policy.");
    throw createRpcError(-32602, evaluation.message, {
      reason: evaluation.reason,
      direction: DIRECTION,
    });
  }

  if (name === "codex_job_status") {
    if (args.job_id) {
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
  return startMcpStdioServer({
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    getTools: getVisibleTools,
    callTool: handleToolCall,
    onShutdown: () => registry.cancelAll("MCP server shutting down."),
  });
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
    process.argv[1]?.endsWith("codex-mcp.mjs")) {
  startCodexMcpServer();
}
