import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const SHIPPED_CONFIG_PATH = path.join(REPO_ROOT, "bridge.config.json");

export const DIRECTIONS = Object.freeze({
  ANTIGRAVITY_TO_CODEX: "antigravity_to_codex",
  CODEX_TO_ANTIGRAVITY: "codex_to_antigravity",
});

export const VALID_DIRECTIONS = new Set(Object.values(DIRECTIONS));

export const BRIDGE_ENV_VARS = Object.freeze([
  "AGENT_BRIDGE_DEPTH",
  "AGENT_BRIDGE_MAX_DEPTH",
  "AGENT_BRIDGE_CHAIN",
  "AGENT_BRIDGE_CONFIG",
  "AGENT_BRIDGE_ANTIGRAVITY_TO_CODEX",
  "AGENT_BRIDGE_CODEX_TO_ANTIGRAVITY",
  "AGENT_BRIDGE_ALLOW_CYCLES",
  "AGY_BIN",
  "CODEX_BIN",
  "CODEX_CLI_JS",
]);

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  directions: {
    antigravity_to_codex: true,
    codex_to_antigravity: false,
  },
  max_depth: 1,
  allow_cycles: false,
});

export function getDefaultUserConfigPath() {
  return path.join(
    os.homedir(),
    ".gemini",
    "config",
    "antigravity-codex-bridge",
    "bridge.config.json"
  );
}

function parseBoolEnv(raw, varName) {
  if (raw === undefined || raw === "") return undefined;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "on" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "off" || normalized === "no") {
    return false;
  }
  throw new Error(`Invalid boolean for ${varName}: "${raw}" (expected true/false).`);
}

function parseNonNegativeInt(raw, label, max = 10) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw.trim()))
    ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new Error(`Invalid ${label}: "${raw}" (expected integer between 0 and ${max}).`);
  }
  return n;
}

function readJsonFileStrict(filePath, required) {
  if (!fs.existsSync(filePath)) {
    if (required) {
      throw new Error(`Explicitly configured bridge config file not found: ${filePath}`);
    }
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`Malformed JSON in bridge config (${filePath}): ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Bridge config must be a JSON object: ${filePath}`);
  }
  return parsed;
}

function mergeConfigLayer(base, layer, sourceLabel) {
  if (!layer) return base;
  const next = {
    version: base.version,
    directions: { ...base.directions },
    max_depth: base.max_depth,
    allow_cycles: base.allow_cycles,
  };

  if (layer.version !== undefined) {
    if (layer.version !== 1) {
      throw new Error(`Unsupported bridge config version (${layer.version}) in ${sourceLabel}.`);
    }
    next.version = 1;
  }

  if (layer.directions !== undefined) {
    if (!layer.directions || typeof layer.directions !== "object" || Array.isArray(layer.directions)) {
      throw new Error(`'directions' must be an object in ${sourceLabel}.`);
    }
    for (const key of Object.values(DIRECTIONS)) {
      if (layer.directions[key] !== undefined) {
        if (typeof layer.directions[key] !== "boolean") {
          throw new Error(`'directions.${key}' must be a boolean in ${sourceLabel}.`);
        }
        next.directions[key] = layer.directions[key];
      }
    }
  }

  if (layer.max_depth !== undefined) {
    next.max_depth = parseNonNegativeInt(layer.max_depth, `'max_depth' in ${sourceLabel}`);
    if (next.max_depth === undefined) throw new Error(`Missing max_depth value in ${sourceLabel}.`);
  }

  if (layer.allow_cycles !== undefined) {
    if (typeof layer.allow_cycles !== "boolean") {
      throw new Error(`'allow_cycles' must be a boolean in ${sourceLabel}.`);
    }
    next.allow_cycles = layer.allow_cycles;
  }

  return next;
}

/**
 * Resolve effective bridge configuration with precedence:
 *   env vars > user config (AGENT_BRIDGE_CONFIG or default user path) > shipped defaults > built-in defaults
 */
export function loadBridgeConfig(env = process.env, defaultUserPath = getDefaultUserConfigPath()) {
  let config = {
    version: DEFAULT_CONFIG.version,
    directions: { ...DEFAULT_CONFIG.directions },
    max_depth: DEFAULT_CONFIG.max_depth,
    allow_cycles: DEFAULT_CONFIG.allow_cycles,
  };

  const sources = [];

  const shippedLayer = readJsonFileStrict(SHIPPED_CONFIG_PATH, false);
  if (shippedLayer) {
    config = mergeConfigLayer(config, shippedLayer, SHIPPED_CONFIG_PATH);
    sources.push(SHIPPED_CONFIG_PATH);
  }

  const explicitConfigPath = env.AGENT_BRIDGE_CONFIG?.trim();
  const userConfigPath = explicitConfigPath || defaultUserPath;
  if (explicitConfigPath && !path.isAbsolute(explicitConfigPath)) {
    throw new Error(`AGENT_BRIDGE_CONFIG must be an absolute path: "${explicitConfigPath}"`);
  }

  const userLayer = readJsonFileStrict(userConfigPath, Boolean(explicitConfigPath));
  if (userLayer) {
    config = mergeConfigLayer(config, userLayer, userConfigPath);
    sources.push(userConfigPath);
  }

  const agyToCodexEnv = parseBoolEnv(
    env.AGENT_BRIDGE_ANTIGRAVITY_TO_CODEX,
    "AGENT_BRIDGE_ANTIGRAVITY_TO_CODEX"
  );
  if (agyToCodexEnv !== undefined) {
    config.directions.antigravity_to_codex = agyToCodexEnv;
  }

  const codexToAgyEnv = parseBoolEnv(
    env.AGENT_BRIDGE_CODEX_TO_ANTIGRAVITY,
    "AGENT_BRIDGE_CODEX_TO_ANTIGRAVITY"
  );
  if (codexToAgyEnv !== undefined) {
    config.directions.codex_to_antigravity = codexToAgyEnv;
  }

  const maxDepthEnv = parseNonNegativeInt(env.AGENT_BRIDGE_MAX_DEPTH, "AGENT_BRIDGE_MAX_DEPTH");
  if (maxDepthEnv !== undefined) {
    config.max_depth = maxDepthEnv;
  }

  const allowCyclesEnv = parseBoolEnv(env.AGENT_BRIDGE_ALLOW_CYCLES, "AGENT_BRIDGE_ALLOW_CYCLES");
  if (allowCyclesEnv !== undefined) {
    config.allow_cycles = allowCyclesEnv;
  }

  return {
    config,
    userConfigPath,
    sources,
  };
}

/**
 * Parse and validate incoming delegation context from process environment.
 */
export function readDelegationContext(env = process.env) {
  const rawDepth = env.AGENT_BRIDGE_DEPTH;
  const rawChain = env.AGENT_BRIDGE_CHAIN;
  const hasDepth = rawDepth !== undefined && rawDepth !== "";
  const hasChain = rawChain !== undefined && rawChain !== "";

  if (!hasDepth && !hasChain) {
    return { depth: 0, chain: [] };
  }

  if (hasDepth !== hasChain) {
    throw new Error(
      "Malformed delegation context: AGENT_BRIDGE_DEPTH and AGENT_BRIDGE_CHAIN must either both be set or both be unset."
    );
  }

  const depth = parseNonNegativeInt(rawDepth, "AGENT_BRIDGE_DEPTH", 100);
  let chain;
  try {
    chain = JSON.parse(rawChain);
  } catch (err) {
    throw new Error(`Malformed AGENT_BRIDGE_CHAIN JSON: ${err.message}`);
  }
  if (!Array.isArray(chain)) {
    throw new Error("Malformed AGENT_BRIDGE_CHAIN: expected a JSON array.");
  }
  if (chain.length !== depth) {
    throw new Error(
      `Malformed delegation context: AGENT_BRIDGE_DEPTH (${depth}) does not match AGENT_BRIDGE_CHAIN length (${chain.length}).`
    );
  }
  for (let i = 0; i < chain.length; i++) {
    const hop = chain[i];
    if (!VALID_DIRECTIONS.has(hop)) {
      throw new Error(`Malformed AGENT_BRIDGE_CHAIN: unknown direction "${hop}" at index ${i}.`);
    }
    if (i > 0 && chain[i - 1] === hop) {
      throw new Error(
        `Malformed AGENT_BRIDGE_CHAIN: consecutive identical direction "${hop}" at index ${i}.`
      );
    }
  }

  return { depth, chain };
}

/**
 * Check whether a bridge server operating in `direction` is allowed to launch a new delegated agent.
 */
export function evaluateDelegationPolicy(direction, env = process.env) {
  if (!VALID_DIRECTIONS.has(direction)) {
    throw new Error(`Unknown bridge direction: ${direction}`);
  }

  let loaded;
  try {
    loaded = loadBridgeConfig(env);
  } catch (err) {
    return {
      allowed: false,
      directionEnabled: false,
      reason: "invalid_config",
      message: err instanceof Error ? err.message : String(err),
      config: null,
      context: null,
    };
  }

  const { config, userConfigPath } = loaded;
  const directionEnabled = Boolean(config.directions[direction]);

  if (!directionEnabled) {
    return {
      allowed: false,
      directionEnabled: false,
      reason: "direction_disabled",
      message: `Delegation direction '${direction}' is disabled by user policy (${userConfigPath}). Enable it with: node scripts/configure.mjs --${direction.replace(/_/g, "-")} on`,
      config,
      context: { depth: 0, chain: [] },
    };
  }

  let context;
  try {
    context = readDelegationContext(env);
  } catch (err) {
    return {
      allowed: false,
      directionEnabled: true,
      reason: "invalid_context",
      message: err instanceof Error ? err.message : String(err),
      config,
      context: null,
    };
  }

  if (context.depth >= config.max_depth) {
    return {
      allowed: false,
      directionEnabled: true,
      reason: "max_depth_reached",
      message: `Delegation depth limit reached (${context.depth}/${config.max_depth}, chain: [${context.chain.join(" -> ")}]).`,
      config,
      context,
    };
  }

  if (!config.allow_cycles && context.chain.includes(direction)) {
    return {
      allowed: false,
      directionEnabled: true,
      reason: "cycle_blocked",
      message: `Delegation cycle blocked: direction '${direction}' already appears in chain [${context.chain.join(" -> ")}]. Set allow_cycles: true to permit repeated hops up to max_depth.`,
      config,
      context,
    };
  }

  return {
    allowed: true,
    directionEnabled: true,
    reason: null,
    message: null,
    config,
    context,
    userConfigPath,
  };
}

/**
 * Construct a fresh child environment that propagates delegation depth, chain, and effective policy.
 */
export function buildChildBridgeEnv(direction, evaluation, baseEnv = process.env) {
  const nextDepth = evaluation.context.depth + 1;
  const nextChain = [...evaluation.context.chain, direction];

  const childEnv = {
    ...baseEnv,
    AGENT_BRIDGE_DEPTH: String(nextDepth),
    AGENT_BRIDGE_MAX_DEPTH: String(evaluation.config.max_depth),
    AGENT_BRIDGE_CHAIN: JSON.stringify(nextChain),
    AGENT_BRIDGE_ANTIGRAVITY_TO_CODEX: String(evaluation.config.directions.antigravity_to_codex),
    AGENT_BRIDGE_CODEX_TO_ANTIGRAVITY: String(evaluation.config.directions.codex_to_antigravity),
    AGENT_BRIDGE_ALLOW_CYCLES: String(evaluation.config.allow_cycles),
  };

  if (evaluation.userConfigPath && fs.existsSync(evaluation.userConfigPath)) {
    childEnv.AGENT_BRIDGE_CONFIG = evaluation.userConfigPath;
  }

  return {
    env: childEnv,
    nextDepth,
    nextChain,
  };
}

/**
 * Check whether Codex's user config.toml declares `[mcp_servers.antigravity-local]`.
 * Only when present should we pass per-invocation `-c mcp_servers.antigravity-local.env_vars=...`.
 */
export function hasCodexAntigravityMcpConfigured(env = process.env) {
  const codexHome = env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) return false;
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return /^\s*\[mcp_servers\.(?:"antigravity-local"|'antigravity-local'|antigravity-local)\]/m.test(
      raw
    );
  } catch {
    return false;
  }
}

export function getCodexEnvVarsOverrideArg() {
  const quoted = BRIDGE_ENV_VARS.map((k) => `"${k}"`).join(",");
  return `mcp_servers.antigravity-local.env_vars=[${quoted}]`;
}
