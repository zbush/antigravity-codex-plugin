#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codex, matches, peerTable, registration, serverName, serverPath, statements } from "../server/lib/codex-cli.mjs";
import { BRIDGE_ENV_VARS, resolvePolicyPath, loadBridgeConfig } from "../server/lib/bridge.mjs";

const modes = {
  "agy-master": [true, false, 1],
  "codex-master": [false, true, 1],
  bidirectional: [true, true, 1],
  off: [false, false, 0],
};
const usage = [
  "Usage: node scripts/configure.mjs [options]",
  "  --status                           Show effective policy and Codex registration",
  "  --mode agy-master|codex-master|bidirectional|off",
  "  --antigravity-to-codex on|off      --codex-to-antigravity on|off",
  "  --allow-cycles on|off               --max-depth 0..10",
  "  --config <absolute path>            Select the bridge policy file",
  "  --wire-codex | --unwire-codex       Add or remove antigravity-local",
  "  --force                            Allow replacing/removing a different registration",
  "  --help                             Show this help (on/off also accept true/false)",
  "",
  "Examples:",
  "  node scripts/configure.mjs --mode bidirectional --wire-codex",
  "  node scripts/configure.mjs --codex-to-antigravity off --status",
].join("\n");

function parseOptions(argv) {
  const options = {};
  const switches = ["--status", "--wire-codex", "--unwire-codex", "--force", "--help"];
  const booleans = ["--antigravity-to-codex", "--codex-to-antigravity", "--allow-cycles"];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (switches.includes(flag)) {
      options[flag.slice(2)] = true;
      continue;
    }
    if (!booleans.includes(flag) && !["--config", "--mode", "--max-depth"].includes(flag)) {
      throw new Error("Unknown option " + flag);
    }
    let value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error("Missing value for " + flag);
    if (booleans.includes(flag)) {
      if (!/^(on|off|true|false)$/i.test(value)) throw new Error(flag + " expects on/off or true/false.");
      value = /^(on|true)$/i.test(value);
    } else if (flag === "--max-depth") {
      if (!/^\d+$/.test(value) || Number(value) > 10) throw new Error("--max-depth expects an integer from 0 to 10.");
      value = Number(value);
    } else if (flag === "--config" && !path.isAbsolute(value)) {
      throw new Error("--config requires an absolute path.");
    } else if (flag === "--mode" && !Object.hasOwn(modes, value)) {
      throw new Error("Unknown mode " + value);
    }
    options[flag.slice(2)] = value;
  }
  if (options["wire-codex"] && options["unwire-codex"]) throw new Error("Choose one Codex registration action.");
  return options;
}

function readOptional(file) {
  try { return fs.readFileSync(file, "utf8"); } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function writeAtomic(file, previous, content) {
  const target = previous === null ? file : fs.realpathSync(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), "." + path.basename(target) + "." + randomUUID() + ".tmp");
  try {
    const mode = previous === null ? 0o600 : fs.statSync(target).mode;
    fs.writeFileSync(temp, content, { flag: "wx", mode });
    if (readOptional(target) !== previous) throw new Error("File changed during update. Retry: " + file);
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function configurePolicy(file, opts) {
  const editing = ["mode", "max-depth", "allow-cycles", "antigravity-to-codex", "codex-to-antigravity"]
    .some((key) => opts[key] !== undefined);
  if (editing) {
    const prior = readOptional(file);
    const original = prior === null ? {} : JSON.parse(prior);
    // Never persist transient environment overrides when editing the file.
    const { config } = loadBridgeConfig({}, file);
    if (opts.mode) {
      const [forward, reverse, depth] = modes[opts.mode];
      config.directions = { antigravity_to_codex: forward, codex_to_antigravity: reverse };
      config.max_depth = depth;
      config.allow_cycles = false;
    }
    for (const direction of Object.keys(config.directions)) {
      config.directions[direction] = opts[direction.replaceAll("_", "-")] ?? config.directions[direction];
    }
    config.max_depth = opts["max-depth"] ?? config.max_depth;
    config.allow_cycles = opts["allow-cycles"] ?? config.allow_cycles;
    const merged = { ...original, ...config, directions: { ...original.directions, ...config.directions } };
    writeAtomic(file, prior, JSON.stringify(merged, null, 2) + "\n");
  }
  console.log("Bridge config " + (editing ? "written" : "selected") + ": " + file);
  if (opts.status) {
    const env = { ...process.env };
    if (opts.config) delete env.AGENT_BRIDGE_CONFIG;
    const { config, userConfigPath } = loadBridgeConfig(env, file);
    if (env.AGENT_BRIDGE_INHERITED_POLICY) console.log("The inherited delegation ceiling applies to this status.");
    console.log("Effective policy (" + userConfigPath + "): " + JSON.stringify(config, null, 2));
  }
}

function ensureEnvVars(info) {
  const missing = BRIDGE_ENV_VARS.filter((key) => !info.transport.env_vars?.includes(key));
  if (!missing.length) return;
  const file = path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"), "config.toml");
  const source = fs.readFileSync(file, "utf8");
  const key = /^\s*(?:env_vars|"env_vars"|'env_vars')\s*=\s*\[/;
  let table, arrayStart;
  for (const statement of statements(source)) {
    if (statement.text.trimStart().startsWith("[")) {
      if (table) break;
      if (peerTable.test(statement.text)) table = statement;
    } else if (table) {
      const prefix = statement.text.match(key);
      if (prefix) arrayStart = statement.start + prefix[0].length;
    }
  }
  if (!table) throw new Error("Cannot locate [mcp_servers." + serverName + "] in " + file);
  const names = missing.map((key) => JSON.stringify(key)).join(", ");
  let updated;
  if (arrayStart !== undefined) {
    // A trailing comma is valid in TOML, including in an otherwise empty array.
    updated = source.slice(0, arrayStart) + names + ", " + source.slice(arrayStart);
  } else {
    if (info.transport.env_vars?.length) throw new Error("Cannot safely locate existing env_vars in " + file);
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const separator = table.text.endsWith("\n") ? "" : eol;
    updated = source.slice(0, table.end) + separator + "env_vars = [" + names + "]" + eol + source.slice(table.end);
  }
  writeAtomic(file, source, updated);
}

function configureRegistration(opts) {
  const wire = opts["wire-codex"], unwire = opts["unwire-codex"];
  if (!wire && !unwire && !opts.status) {
    console.log("Codex registration: no action requested.");
    return;
  }
  let info = registration();
  const ours = info && matches(info);
  if ((wire || unwire) && info && !ours && !opts.force) {
    throw new Error(serverName + " points to a different command or server. Use --force to replace or remove it.");
  }
  if (wire) {
    if (!ours) {
      if (info) codex(["remove", serverName]);
      codex(["add", serverName, "--", process.execPath, serverPath]);
      info = registration();
      if (!info || !matches(info)) throw new Error("Codex did not register the expected command.");
    }
    ensureEnvVars(info);
    console.log("Codex registration: " + serverName + " registered with bridge environment forwarding.");
  } else if (unwire) {
    if (info) codex(["remove", serverName]);
    console.log("Codex registration: " + serverName + (info ? " removed." : " already absent."));
  } else {
    const status = !info ? "absent" : !ours ? "different command or server" :
      (info.enabled === false ? "registered, disabled" : "registered") +
      (BRIDGE_ENV_VARS.every((k) => info.transport.env_vars?.includes(k)) ? ", forwarding configured" : ", forwarding incomplete");
    console.log("Codex registration: " + serverName + " " + status + ".");
  }
}

function main() {
  const opts = parseOptions(process.argv.slice(2));
  if (opts.help || process.argv.length === 2) return console.log(usage);
  const file = resolvePolicyPath(opts.config ?? process.env.AGENT_BRIDGE_CONFIG);
  try { configurePolicy(file, opts); } catch (err) {
    console.error("Bridge config error (" + file + "): " + err.message);
    process.exitCode = 1;
  }
  try { configureRegistration(opts); } catch (err) {
    console.error("Codex registration unavailable: " + err.message);
    if (opts["wire-codex"] || opts["unwire-codex"]) process.exitCode = 1;
  }
}

try { main(); } catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
