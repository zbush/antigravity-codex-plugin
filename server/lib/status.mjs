import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describeWorkspacePolicy, isFullyAbsolute, loadWorkspacePolicy } from "./workspace-policy.mjs";

const run = promisify(execFile);

function resolvePathBinary(command) {
  if (isFullyAbsolute(command)) return command;
  for (const dir of (process.env.PATH ?? "/usr/bin:/bin").split(path.delimiter).filter(isFullyAbsolute)) {
    const candidate = path.resolve(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* Continue searching PATH. */ }
  }
  throw new Error("Cannot find " + command + " on PATH.");
}

export async function bridgeStatus(resolveInvocation, evaluation, registry, signal) {
  const status = {
    binary: null, binary_source: null, version: null,
    bridge_policy: evaluation.config, context: evaluation.context,
    launch_allowed: evaluation.allowed, reason: evaluation.reason,
    workspace_policy: describeWorkspacePolicy(loadWorkspacePolicy()),
    active_jobs: registry.activeChildren.size, max_concurrent: evaluation.config.max_concurrent,
  };
  try {
    const { command, args, binary, source } = resolveInvocation(["--version"]);
    const executable = resolvePathBinary(command);
    status.binary = path.isAbsolute(binary) ? binary : executable;
    status.binary_source = source;
    const probe = run(executable, args, { timeout: 2000, killSignal: "SIGKILL", maxBuffer: 16 * 1024, windowsHide: true, signal });
    probe.child.stdin.end();
    const { stdout, stderr } = await probe;
    status.version = stdout.trim() || stderr.trim();
  } catch (error) {
    if (error.code === "ENOENT") status.binary = null;
    if (status.binary === null) status.binary_error = error.message;
    else status.version_error = error.killed && error.code == null ? "CLI version probe timed out after 2 seconds." : error.message;
  }
  return {
    content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
    isError: Boolean(status.binary_error || status.version_error),
  };
}
