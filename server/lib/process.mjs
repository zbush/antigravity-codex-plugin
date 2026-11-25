import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_TIMEOUT_SECONDS = 600;
export const MAX_TIMEOUT_SECONDS = 1800;
export const MAX_RECENT_EVENTS = 40;
export const MAX_STDERR_CHARS = 16000;

export function findWindowsCommand(name, env) {
  const dirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  for (const suffix of [".exe", "", ".cmd", ".bat"]) {
    for (const dir of dirs) {
      const file = path.resolve(dir.replace(/^"|"$/g, ""), name + suffix);
      if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return file;
    }
  }
  return name;
}

// Quote for the program's argv parser, then protect cmd metacharacters on
// both passes (cmd /c and the batch shim's %* forwarding).
export function windowsBatchInvocation(command, args) {
  const escapeMeta = (s) => s.replace(/[()%!^"<>&| \t]/g, "^$&");
  const quotedArgs = args.map((arg) => {
    if (/[\r\n\0]/.test(arg)) throw new Error("Batch arguments must be single-line strings.");
    const quoted = '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"';
    return escapeMeta(escapeMeta(quoted));
  });
  const line = [escapeMeta(command), ...quotedArgs].join(" ");
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", '"' + line + '"'],
    windowsVerbatimArguments: true,
    shell: false,
  };
}

export function expandHome(inputPath) {
  if (typeof inputPath !== "string") return inputPath;
  const trimmed = inputPath.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function validateAbsoluteDir(dirPath, fieldName = "cwd") {
  if (typeof dirPath !== "string" || !dirPath.trim()) {
    throw new Error(`'${fieldName}' must be a non-empty absolute directory path.`);
  }
  const expanded = expandHome(dirPath);
  if (!path.isAbsolute(expanded)) {
    throw new Error(`'${fieldName}' must be an absolute directory path: "${dirPath}"`);
  }
  const resolved = path.resolve(expanded);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Directory does not exist (${fieldName}): ${resolved}`);
  }
  return resolved;
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
    const args = ["/T", "/PID", String(pid)];
    const options = { stdio: "ignore", windowsHide: true };
    if (force) {
      // Shutdown can immediately exit the MCP process. Finish the forced
      // attempt here so a failed taskkill can still fall back to the child handle.
      const result = spawnSync("taskkill", ["/F", ...args], { ...options, timeout: 3000 });
      if (result.status !== 0) {
        try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
      }
      return;
    }
    try {
      const killer = spawn("taskkill", args, options);
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
export function createJobRegistry() {
  const jobs = new Map();
  const activeChildren = new Set();

  const cancelAll = (reason = "Server shutting down or direction disabled.") => {
    for (const job of jobs.values()) {
      if (job.status === "running" && typeof job.cancel === "function") {
        job.cancel(reason);
      }
    }
    for (const child of activeChildren) {
      terminateProcessTree(child, true);
    }
    activeChildren.clear();
  };

  return {
    jobs,
    activeChildren,
    cancelAll,
  };
}
