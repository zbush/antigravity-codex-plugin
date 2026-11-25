import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configuredFile, findWindowsCommand, windowsBatchInvocation } from "./process.mjs";

export const serverName = "antigravity-local";
export const serverPath = fileURLToPath(new URL("../antigravity-mcp.mjs", import.meta.url));
export const peerTable = /^\s*\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:antigravity-local|"antigravity-local"|'antigravity-local')\s*\]\s*(?:#.*)?\s*$/;

export function resolveCodexInvocation(codexArgs, env = process.env) {
  const configuredBin = configuredFile(env.CODEX_BIN, "CODEX_BIN");
  if (configuredBin) {
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(configuredBin)) {
      return windowsBatchInvocation(configuredBin, codexArgs);
    }
    return {
      command: configuredBin,
      args: codexArgs,
      shell: false,
    };
  }

  const configuredJs = configuredFile(env.CODEX_CLI_JS, "CODEX_CLI_JS");
  if (configuredJs) {
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
    if (path.isAbsolute(candidate) && fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
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

export function codex(args, allowMissing = false) {
  const invocation = resolveCodexInvocation(["mcp", ...args]);
  const run = spawnSync(invocation.command, invocation.args, {
    windowsVerbatimArguments: invocation.windowsVerbatimArguments, windowsHide: true,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
  });
  if (run.error) throw run.error;
  if (run.status === 0) return run.stdout;
  const detail = (run.stderr || run.stdout || "CLI exited with " + (run.signal ?? run.status)).trim();
  if (allowMissing && /^ *(?:Error: )?No MCP server named ['"]antigravity-local['"] found\.?\s*$/im.test(detail)) {
    return null;
  }
  throw new Error(detail);
}

export function registration() {
  const json = codex(["get", "--json", serverName], true);
  if (json === null) return null;
  const info = JSON.parse(json);
  if (!info?.transport) throw new Error("Unexpected response to codex mcp get.");
  return info;
}

function sameFile(a, b) {
  if (typeof a !== "string" || !path.isAbsolute(a)) return false;
  if (path.relative(a, b) === "") return true;
  return fs.existsSync(a) && fs.existsSync(b) && path.relative(fs.realpathSync(a), fs.realpathSync(b)) === "";
}

export function matches(info) {
  const { type, command, args } = info.transport;
  const node = sameFile(command, process.execPath) || command === "node" ||
    (process.platform === "win32" && command?.toLowerCase() === "node.exe");
  return type === "stdio" && node && args?.length === 1 && sameFile(args[0], serverPath);
}

// Walk complete TOML statements. Skip quoted text and comments so examples
// embedded in multiline strings and arrays cannot masquerade as table headers.
export function* statements(source) {
  const tokens = /"""|'''|"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|#[^\r\n]*|[\[\]{}\n]/g;
  let start = 0, nesting = 0;
  for (let i = 0; i < source.length;) {
    tokens.lastIndex = i;
    const match = tokens.exec(source);
    if (!match) break;
    const at = match.index;
    i = tokens.lastIndex;
    // Triple-quoted TOML strings can span newlines and end in 3–5 quotes.
    const triple = match[0];
    if (triple === '"""' || triple === "'''") {
      const end = triple === '"""' ? /\\[\s\S]|"{3,5}/g : /'{3,5}/g;
      end.lastIndex = at + 3;
      let close;
      do { close = end.exec(source); } while (close && close[0][0] === "\\");
      if (!close) throw new Error("Unterminated TOML string. Check config.toml.");
      i = end.lastIndex;
      continue;
    }
    if (match[0] === "[" || match[0] === "{") nesting++;
    if (match[0] === "]" || match[0] === "}") nesting--;
    if (match[0] === "\n" && nesting === 0) {
      yield { start, end: i, text: source.slice(start, i) };
      start = i;
    }
  }
  if (start < source.length) yield { start, end: source.length, text: source.slice(start) };
}

// Isolated delegates reconstruct only the standard registration. Custom tool and
// approval rules can live in nested TOML tables that "mcp get" does not expose.
export function hasPlainPeerRegistration() {
  const home = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  try {
    const source = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    let inTable = false, found = false;
    for (const statement of statements(source)) {
      const line = statement.text.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("[")) {
        inTable = peerTable.test(line);
        if (inTable) found = true;
        else if (/^\[\s*["']?mcp_servers["']?\s*\.\s*["']?antigravity-local["']?\s*\./.test(line)) return false;
      } else if (inTable && !/^(?:command|args|enabled|env_vars)\s*=/.test(line)) {
        return false;
      }
    }
    if (!found) return false;
    const info = registration();
    return Boolean(info && info.enabled !== false && matches(info) &&
      !info.disabled_reason && !info.enabled_tools && !info.disabled_tools?.length &&
      !info.transport.cwd && !Object.keys(info.transport.env ?? {}).length);
  } catch {
    return false;
  }
}
