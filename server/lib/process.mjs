import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isFullyAbsolute } from "./workspace-policy.mjs";

export const DEFAULT_TIMEOUT_SECONDS = 600;
export const MAX_TIMEOUT_SECONDS = 1800;
export const MAX_RECENT_EVENTS = 40;
export const MAX_STDERR_CHARS = 16000;

function windowsSystemTool(name) {
  const root = [process.env.SystemRoot, process.env.WINDIR].find(dir => /^[a-z]:[\\/]/i.test(dir ?? ""));
  if (!root) throw new Error("A fully qualified SystemRoot or WINDIR is required for " + name + ".");
  return path.join(root, "System32", name);
}

export function findWindowsCommand(name, env) {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter)
    .map(dir => dir.replace(/^"|"$/g, "")).filter(isFullyAbsolute);
  const candidates = [name + ".exe"];
  if (name === "codex") candidates.push(path.join("node_modules", "@openai", "codex", "bin", "codex.js"));
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const file = path.join(dir, candidate);
      if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return file;
    }
  }
  throw new Error("Cannot find " + name + " on PATH. Configure its absolute executable path (.exe or JavaScript entry point).");
}

export function configuredFile(file, variable) {
  if (!file) return undefined;
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    const guidance = variable === "CODEX_BIN" ? "a .exe or CODEX_CLI_JS for a JavaScript entry point" : "a .exe or JavaScript entry point";
    throw new Error(variable + " does not support batch files. Use " + guidance + ".");
  }
  if (!isFullyAbsolute(file) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(variable + " must point to an existing absolute file.");
  }
  return file;
}

export function cliInvocation(file, args, source) {
  if (/\.[cm]?js$/i.test(file) || source === "CODEX_CLI_JS") {
    return { command: process.execPath, args: [file, ...args], shell: false, binary: file, source };
  }
  return { command: file, args, shell: false, binary: file, source };
}

export function isClosedStdinError(error) {
  // libuv can report a closed child stdin pipe as "write EOF" on Windows.
  return error.code === "EPIPE" || (process.platform === "win32" && error.code === "EOF" && error.syscall === "write");
}

export function clampTimeoutMs(timeoutSeconds) {
  const seconds =
    typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds)
      ? Math.max(10, Math.min(MAX_TIMEOUT_SECONDS, Math.floor(timeoutSeconds)))
      : DEFAULT_TIMEOUT_SECONDS;
  return seconds * 1000;
}

/**
 * Terminate a child process and its owned process tree cross-platform.
 */
export function terminateProcessTree(child, force = false) {
  if (!child || !child.pid) return;
  const pid = child.pid;

  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const args = ["/T", "/PID", String(pid)];
    const options = { stdio: "ignore", windowsHide: true };
    if (force) {
      // Shutdown can immediately exit the MCP process. Finish the forced
      // attempt here so a failed taskkill can still fall back to the child handle.
      try {
        if (spawnSync(windowsSystemTool("taskkill.exe"), ["/F", ...args], { ...options, timeout: 3000 }).status === 0) return;
      } catch { /* A filtered environment can lack the system tool. */ }
      try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
      return;
    }
    try {
      const killer = spawn(windowsSystemTool("taskkill.exe"), args, options);
      // If taskkill is unavailable the caller will escalate to the forced attempt.
      killer.on("error", () => {});
      killer.unref();
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    return;
  }

  // On POSIX, spawn with detached: true creates a process group led by child.pid.
  const sig = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // ignore
    }
  }
}

/**
 * Track and manage spawned child jobs cleanly across servers.
 */
export function createJobRegistry(onActiveChange) {
  const jobs = new Map();
  const activeChildren = new Set();
  const recentFinished = [];

  const track = (job, child) => {
    jobs.set(job.job_id, job);
    activeChildren.add(child);
    onActiveChange?.();
  };

  const finish = (job, child) => {
    activeChildren.delete(child);
    delete job.cancel;
    delete job.cleanup;
    onActiveChange?.();
    recentFinished.push(job.job_id);
    if (recentFinished.length <= 50) return;
    const id = recentFinished.shift();
    const old = jobs.get(id);
    // Retain identity, terminal status and launch scope for inspection and session reuse.
    const compact = { ...old, output_pruned: true, response: "", stderr: "", recent_events: [], errors: [], usage: null };
    if (old.commands) {
      compact.commands_run = old.commands.length;
      compact.file_changes_count = old.file_changes.length;
      compact.commands = [];
      compact.file_changes = [];
    }
    if ("structured_output" in old) compact.structured_output = null;
    jobs.set(id, compact);
  };

  const cancelAll = (reason = "Server shutting down or direction disabled.") => {
    for (const job of jobs.values()) {
      if (job.status === "running" && typeof job.cancel === "function") {
        job.cancel(reason);
      }
    }
    for (const child of activeChildren) {
      terminateProcessTree(child, true);
    }
    for (const job of jobs.values()) job.cleanup?.();
  };

  return {
    jobs,
    activeChildren,
    track,
    finish,
    cancelAll,
  };
}
