import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_ENV_VARS, buildChildBridgeEnv, DIRECTIONS, evaluateDelegationPolicy,
  loadBridgeConfig, readDelegationContext, SHIPPED_CONFIG_PATH,
} from "../server/lib/bridge.mjs";
import { resolveAgyInvocation } from "../server/antigravity-mcp.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const forward = DIRECTIONS.ANTIGRAVITY_TO_CODEX;
const reverse = DIRECTIONS.CODEX_TO_ANTIGRAVITY;
const policy = {
  version: 1, directions: { [forward]: true, [reverse]: true }, max_depth: 4, allow_cycles: false,
};
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// Written into the fixture as a standalone CommonJS CLI, with no project imports.
async function mockAgy() {
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  if (input.split("\n").length !== 2 || !input.endsWith("\n")) throw new Error("Expected a single NDJSON line");
  const message = JSON.parse(input);
  const prompt = message.message.content;
  emit({ event: "init", conversation_id: "agy-id", init: { cwd: process.cwd() } });
  const step = { step_type: "agent_response", step_index: 1, state: "ACTIVE" };
  emit({ event: "step_update", step_update: { ...step, text_delta: "partial " } });
  emit({ event: "step_update", step_update: { ...step, text_delta: "answer", usage: { output_tokens: 2 } } });
  if (prompt === "linger") {
    setInterval(() => {}, 10000);
    return;
  }
  if (prompt === "no result") return;
  if (prompt === "nonzero") process.exitCode = 3;
  const result = {
    conversation_id: "agy-id", status: prompt === "cli error" ? "ERROR" : "SUCCESS",
    response: prompt === "cli error" ? "" : "final answer", usage: { total_tokens: 12 },
    structured_output: {
      message, args: process.argv.slice(2), cwd: process.cwd(),
      depth: process.env.AGENT_BRIDGE_DEPTH, chain: process.env.AGENT_BRIDGE_CHAIN,
      maxDepth: process.env.AGENT_BRIDGE_MAX_DEPTH,
    },
  };
  if (prompt === "cli error") result.error = "model error";
  // Split a record across writes and omit the final newline.
  const line = JSON.stringify({ event: "result", result });
  process.stdout.write(line.slice(0, 12));
  setImmediate(() => process.stdout.write(line.slice(12)));
}

async function mockCodex() {
  if (process.argv[2] !== "exec") throw new Error("Expected codex exec");
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  const context = {
    depth: process.env.AGENT_BRIDGE_DEPTH, chain: process.env.AGENT_BRIDGE_CHAIN,
    maxDepth: process.env.AGENT_BRIDGE_MAX_DEPTH, prompt,
  };
  console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-id" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(context) } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3 } }));
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent bridge "));
  const file = path.join(dir, "bridge.json");
  const codexHome = path.join(dir, "codex");
  fs.mkdirSync(codexHome);
  writeJson(file, policy);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (BRIDGE_ENV_VARS.includes(key.toUpperCase())) delete env[key];
  }
  Object.assign(env, {
    CODEX_HOME: codexHome, AGENT_BRIDGE_CONFIG: file,
    AGY_BIN: path.join(dir, "mock agy.cjs"), CODEX_CLI_JS: path.join(dir, "mock codex.cjs"),
  });
  fs.writeFileSync(env.AGY_BIN, "(" + mockAgy.toString() + ")();");
  fs.writeFileSync(env.CODEX_CLI_JS, "(" + mockCodex.toString() + ")();");
  const clients = [];
  t.after(async () => {
    try { await Promise.all(clients.map((client) => client.close())); }
    finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
  });
  return {
    dir, file, env, codexHome,
    connect(name, overrides) {
      const client = rpcClient(name, { ...env, ...overrides });
      clients.push(client);
      return client;
    },
  };
}

function rpcClient(name, env) {
  const child = spawn(process.execPath, [path.join(root, "server", name + "-mcp.mjs")], {
    env, stdio: "pipe", windowsHide: true,
  });
  const pending = new Map(), notifications = [];
  let nextId = 0, stderr = "";
  child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) notifications.push(message.method);
    else pending.get(message.id)?.resolve(message);
  });
  const closed = once(child, "close").then(([code]) => {
    for (const request of pending.values()) request.reject(new Error("MCP closed: " + stderr));
    return code;
  });
  async function request(method, params = {}) {
    const id = ++nextId;
    let timeout;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timeout = setTimeout(() => reject(new Error(method + " timed out: " + stderr)), 15000);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    } finally { clearTimeout(timeout); pending.delete(id); }
  }
  return {
    request, notifications,
    call: (tool, args) => request("tools/call", { name: tool, arguments: args }),
    async tools() { return (await request("tools/list")).result.tools.map((tool) => tool.name); },
    async close() {
      child.stdin.end();
      const killer = setTimeout(() => child.kill(), 5000);
      try { assert.equal(await closed, 0, stderr); } finally { clearTimeout(killer); }
    },
  };
}

function payload(message, isError = false) {
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  assert.equal(Boolean(message.result.isError), isError, JSON.stringify(message.result));
  return JSON.parse(message.result.content[0].text);
}
function assertDenied(message, reason) {
  assert.equal(message.error?.code, -32602);
  assert.equal(message.error.data.reason, reason);
}

test("config precedence and independent direction flags", (t) => {
  const { file, dir } = fixture(t);
  const shipped = readJson(SHIPPED_CONFIG_PATH);
  assert.deepEqual(loadBridgeConfig({}, path.join(dir, "absent")).config, shipped);
  writeJson(file, { directions: { [reverse]: true }, max_depth: 3 });
  const env = { AGENT_BRIDGE_CONFIG: file, AGENT_BRIDGE_ANTIGRAVITY_TO_CODEX: "off", AGENT_BRIDGE_MAX_DEPTH: "5" };
  const loaded = loadBridgeConfig(env);
  assert.deepEqual(loaded.sources, [SHIPPED_CONFIG_PATH, file]);
  assert.deepEqual(loaded.config, { ...shipped, directions: { [forward]: false, [reverse]: true }, max_depth: 5 });
  assert.equal(evaluateDelegationPolicy(forward, env).reason, "direction_disabled");
  assert.equal(evaluateDelegationPolicy(reverse, env).allowed, true);
  assert.equal(loadBridgeConfig({ AGENT_BRIDGE_CONFIG: file }).config.directions[forward], shipped.directions[forward]);
});

test("invalid policies and malformed delegation contexts fail closed", (t) => {
  const { file, env } = fixture(t);
  for (const invalid of [
    { max_depth: -1 }, { max_depth: 11 }, { max_depth: "2junk" }, { max_depth: null },
    { directions: { [reverse]: 1 } }, { directions: [] }, { allow_cycles: "yes" }, { version: 2 }, [],
  ]) {
    writeJson(file, invalid);
    assert.equal(evaluateDelegationPolicy(reverse, env).reason, "invalid_config");
  }
  fs.writeFileSync(file, "{");
  assert.throws(() => loadBridgeConfig(env), /Malformed JSON/);
  writeJson(file, policy);
  for (const overrides of [
    { AGENT_BRIDGE_CONFIG: "relative.json" }, { AGENT_BRIDGE_CONFIG: file + ".missing" },
    { AGENT_BRIDGE_ALLOW_CYCLES: "sometimes" }, { AGENT_BRIDGE_MAX_DEPTH: "2.5" },
  ]) assert.throws(() => loadBridgeConfig({ ...env, ...overrides }));
  for (const [depth, chain] of [
    ["1", ""], ["", "[]"], ["1", "bad"], ["0", "{}"], ["1", "[]"], ["1x", JSON.stringify([forward])],
    ["1", '["unknown"]'], ["2", JSON.stringify([forward, forward])],
  ]) {
    assert.equal(evaluateDelegationPolicy(reverse, {
      ...env, AGENT_BRIDGE_DEPTH: depth, AGENT_BRIDGE_CHAIN: chain,
    }).reason, "invalid_context");
  }
});

test("depth, repeated hops, and child environment propagation", (t) => {
  const { env, file } = fixture(t);
  const base = { ...env, AGENT_BRIDGE_DEPTH: "2", AGENT_BRIDGE_CHAIN: JSON.stringify([reverse, forward]) };
  assert.deepEqual(readDelegationContext({}), { depth: 0, chain: [] });
  assert.equal(evaluateDelegationPolicy(reverse, base).reason, "cycle_blocked");
  assert.equal(evaluateDelegationPolicy(reverse, { ...base, AGENT_BRIDGE_MAX_DEPTH: "2" }).reason, "max_depth_reached");
  const evaluation = evaluateDelegationPolicy(reverse, { ...base, AGENT_BRIDGE_ALLOW_CYCLES: "true" });
  assert.equal(evaluation.allowed, true);
  const child = buildChildBridgeEnv(reverse, evaluation, { ...base, PRESERVED: "yes" });
  assert.deepEqual(child.nextChain, [reverse, forward, reverse]);
  assert.equal(child.nextDepth, 3);
  assert.deepEqual(readDelegationContext(child.env), { depth: 3, chain: child.nextChain });
  assert.deepEqual([
    child.env.AGENT_BRIDGE_MAX_DEPTH, child.env.AGENT_BRIDGE_ANTIGRAVITY_TO_CODEX,
    child.env.AGENT_BRIDGE_CODEX_TO_ANTIGRAVITY, child.env.AGENT_BRIDGE_ALLOW_CYCLES,
    child.env.AGENT_BRIDGE_CONFIG, child.env.PRESERVED, base.AGENT_BRIDGE_DEPTH,
  ], ["4", "true", "true", "true", file, "yes", "2"]);
});

for (const [name, direction, incoming] of [["codex", forward, reverse], ["antigravity", reverse, forward]]) {
  test(name + " stdio initialization, delegation, and live policy enforcement", async (t) => {
    const f = fixture(t);
    const client = f.connect(name, { AGENT_BRIDGE_DEPTH: "1", AGENT_BRIDGE_CHAIN: JSON.stringify([incoming]) });
    const init = (await client.request("initialize", { protocolVersion: "2024-11-05" })).result;
    assert.deepEqual(init.serverInfo, { name: name + "-local", version: "2.0.0" });
    assert.equal(init.capabilities.tools.listChanged, true);
    const run = name + "_run";
    const inspect = [name + "_job_status", name + "_job_cancel"];
    const tools = await client.tools();
    assert.ok(tools.includes(run));
    if (name === "antigravity") assert.deepEqual(tools, [run, name + "_spawn", ...inspect]);
    const args = { cwd: f.dir, prompt: "hello\nwith whitespace & Unicode 🌙" };
    const job = payload(await client.call(run, args));
    assert.equal(job.status, "completed");
    const expectedChain = [incoming, direction];
    assert.deepEqual(job.delegation_chain, expectedChain);
    assert.equal(job.delegation_depth, 2);
    const context = name === "codex" ? JSON.parse(job.response) : job.structured_output;
    assert.equal(context.depth, "2");
    assert.deepEqual(JSON.parse(context.chain), expectedChain);
    assert.equal(context.maxDepth, "4");
    if (name === "codex") {
      assert.equal(context.prompt, args.prompt);
      assert.equal(job.session_id, "codex-id");
    } else {
      assert.deepEqual(context.message, { event: "user", message: { content: args.prompt } });
      assert.deepEqual(context.args, ["--input-format", "stream-json", "--output-format", "stream-json",
        "--sandbox", "--disable-slash-commands", "--print-timeout", "600s"]);
      assert.equal(context.cwd, f.dir);
    }
    writeJson(f.file, { ...policy, max_depth: 1 });
    assert.deepEqual(await client.tools(), inspect);
    for (const tool of tools.filter((tool) => !inspect.includes(tool))) {
      assertDenied(await client.call(tool, args), "max_depth_reached");
    }
    assert.equal(payload(await client.call(inspect[0], { job_id: job.job_id })).status, "completed");
    writeJson(f.file, { ...policy, directions: { ...policy.directions, [direction]: false } });
    assert.deepEqual(await client.tools(), []);
    for (const tool of tools) assertDenied(await client.call(tool, args), "direction_disabled");
    assert.deepEqual(client.notifications, ["notifications/tools/list_changed", "notifications/tools/list_changed"]);
  });
}

test("Antigravity maps launch flags and requires a successful terminal result and exit", async (t) => {
  const f = fixture(t);
  const client = f.connect("antigravity");
  const call = (params) => client.call("antigravity_run", { cwd: f.dir, prompt: "test", ...params });
  const schema = { type: "object", description: 'some "text" & a %VARIABLE%' };
  const result = payload(await call({
    resume: { conversation_id: "old-id" }, model: "test model", effort: "high", agent: "local", mode: "fast",
    sandbox: false, disable_slash_commands: false, add_dirs: [f.dir, f.codexHome], json_schema: schema, timeout_seconds: 25,
  }));
  assert.deepEqual(result.structured_output.args, [
    "--input-format", "stream-json", "--output-format", "stream-json", "--conversation", "old-id", "--model", "test model",
    "--agent", "local", "--effort", "high", "--mode", "fast", "--add-dir", f.dir, "--add-dir", f.codexHome,
    "--json-schema", JSON.stringify(schema), "--print-timeout", "25s",
  ]);
  assert.equal(result.conversation_id, "agy-id");
  assert.equal(result.response, "final answer");
  assert.deepEqual(result.usage, { total_tokens: 12 });
  assert.deepEqual(result.recent_events.map((e) => e.event), ["init", "step_update", "step_update", "result"]);
  assert.ok(payload(await call({ resume: { continue_last: true } })).structured_output.args.includes("--continue"));
  for (const params of [{ resume: {} }, { resume: { conversation_id: "id", continue_last: true } },
    { add_dirs: ["relative"] }, { sandbox: "false" }, { timeout_seconds: -2 }, { json_schema: [] }]) {
    assert.equal((await call(params)).error.code, -32602);
  }
  for (const [prompt, response, code] of [
    ["no result", "partial answer", 0], ["cli error", "partial answer", 0], ["nonzero", "final answer", 3],
  ]) {
    const failed = payload(await call({ prompt }), true);
    assert.equal(failed.status, "failed");
    assert.equal(failed.response, response);
    assert.equal(failed.exit_code, code);
    assert.equal(failed.conversation_id, "agy-id");
    assert.ok(failed.errors.length);
  }
});

test("background job inspection, cancellation and parent timeout retain partial output", async (t) => {
  const f = fixture(t);
  const client = f.connect("antigravity");
  const args = { cwd: f.dir, prompt: "linger" };
  const info = payload(await client.call("antigravity_spawn", args));
  assert.equal(info.status, "running");
  const id = { job_id: info.job_id };
  async function poll(predicate) {
    const until = Date.now() + 10000;
    do {
      const job = payload(await client.call("antigravity_job_status", id));
      if (predicate(job)) return job;
      await delay(30);
    } while (Date.now() < until);
    assert.fail("Timed out waiting for background job");
  }
  assert.equal((await poll((job) => job.response === "partial answer")).status, "running");
  assert.equal(payload(await client.call("antigravity_job_status", {})).jobs[0].job_id, info.job_id);
  assert.equal(payload(await client.call("antigravity_job_cancel", id)).cancelled, true);
  const cancelled = await poll((job) => job.status === "cancelled");
  assert.equal(cancelled.response, "partial answer");
  assert.equal(payload(await client.call("antigravity_job_cancel", id)).cancelled, false);
  const timeout = payload(await client.call("antigravity_run", { ...args, timeout_seconds: 1 }), true);
  assert.equal(timeout.status, "timed_out");
  assert.equal(timeout.response, "partial answer");
  assert.equal(timeout.conversation_id, "agy-id");
  assert.deepEqual(timeout.usage, { output_tokens: 2 });
});

test("AGY_BIN and platform installation defaults take precedence over PATH", (t) => {
  const f = fixture(t);
  assert.deepEqual(resolveAgyInvocation(["flag"], f.env), {
    command: process.execPath, args: [f.env.AGY_BIN, "flag"], shell: false,
  });
  const env = { AGY_BIN: path.join(f.dir, "missing"), PATH: f.dir, HOME: f.dir, USERPROFILE: f.dir, LOCALAPPDATA: f.dir };
  const windows = process.platform === "win32";
  const local = path.join(f.dir, ".local", "bin", windows ? "agy.exe" : "agy");
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, "");
  assert.equal(resolveAgyInvocation([], env).command, local);
  if (windows) {
    const appData = path.join(f.dir, "agy", "bin", "agy.exe");
    fs.mkdirSync(path.dirname(appData), { recursive: true });
    fs.writeFileSync(appData, "");
    assert.equal(resolveAgyInvocation([], env).command, appData);
    fs.unlinkSync(local);
    fs.unlinkSync(appData);
    const cmd = path.join(f.dir, "agy.cmd"), exe = path.join(f.dir, "agy.exe");
    fs.writeFileSync(cmd, '@echo off\r\n"' + process.execPath + '" "%~dp0mock agy.cjs" %*\r\n');
    fs.writeFileSync(exe, "");
    assert.equal(resolveAgyInvocation([], env).command, exe);
    fs.unlinkSync(exe);
    const args = ["--json-schema", JSON.stringify({ description: 'quoted "text" & literal %AGY_BIN% (!)' })];
    const invocation = resolveAgyInvocation(args, env);
    assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
    const run = spawnSync(invocation.command, invocation.args, {
      windowsVerbatimArguments: invocation.windowsVerbatimArguments, encoding: "utf8", env: f.env,
      input: '{"event":"user","message":{"content":"test"}}\n',
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim().split("\n").pop()).result;
    assert.deepEqual(result.structured_output.args, args);
  }
});

function mockRegistration() {
  const fs = require("node:fs"), path = require("node:path");
  const home = process.env.CODEX_HOME, file = path.join(home, "registration.json");
  const toml = path.join(home, "config.toml");
  const [mcp, verb, ...args] = process.argv.slice(2);
  if (mcp !== "mcp") throw new Error("Unexpected command");
  fs.appendFileSync(path.join(home, "calls"), verb + "\n");
  if (verb === "get") {
    if (JSON.stringify(args) !== '["--json","antigravity-local"]') throw new Error("Unexpected get arguments");
    if (process.env.FAIL_LOOKUP) throw new Error("Cannot read Codex config");
    if (!fs.existsSync(file)) {
      console.error("Error: No MCP server named 'antigravity-local' found.");
      process.exitCode = 1;
      return;
    }
    const info = JSON.parse(fs.readFileSync(file, "utf8"));
    if (fs.existsSync(toml)) {
      const contents = fs.readFileSync(toml, "utf8");
      // The fixture keeps an unrelated table and a multiline string above the real table.
      const section = contents.split('["mcp_servers".\'antigravity-local\']')[1] || "";
      const match = section.split("[other]")[0].match(/env_vars\s*=\s*\[([^\]]*)\]/);
      info.transport.env_vars = match ? [...match[1].matchAll(/["']([\w]+)["']/g)].map((m) => m[1]) : [];
    }
    console.log(JSON.stringify(info));
  } else if (verb === "add") {
    const [name, separator, command, script] = args;
    if (name !== "antigravity-local" || separator !== "--" || args.length !== 4) throw new Error("Unexpected add arguments");
    fs.writeFileSync(file, JSON.stringify({ name, transport: { type: "stdio", command, args: [script] } }));
    fs.writeFileSync(toml, [
      'notes = """', "[mcp_servers.antigravity-local]", 'env_vars = ["DECOY"]', '"""',
      '["mcp_servers".\'antigravity-local\'] # keep', 'command = ' + JSON.stringify(command),
      'env_vars = [', '  "CUSTOM", # keep this comment', ']', '[other]', 'env_vars = ["UNRELATED"]', '',
    ].join("\r\n"));
  } else if (verb === "remove") {
    if (args.join(" ") !== "antigravity-local") throw new Error("Unexpected remove arguments");
    fs.unlinkSync(file);
  } else throw new Error("Unknown verb");
}

function configurator(f) {
  fs.writeFileSync(f.env.CODEX_CLI_JS, "(" + mockRegistration.toString() + ")();");
  return (args, expectedCode = 0, overrides = {}) => {
    const run = spawnSync(process.execPath, [path.join(root, "scripts/configure.mjs"), "--config", f.file, ...args], {
      env: { ...f.env, ...overrides }, encoding: "utf8", timeout: 15000,
    });
    assert.ifError(run.error);
    assert.equal(run.status, expectedCode, run.stdout + run.stderr);
    return run.stdout + run.stderr;
  };
}

test("configurator applies presets then overrides, replaces atomically and reports effective status", (t) => {
  const f = fixture(t), cli = configurator(f);
  fs.unlinkSync(f.file);
  for (const [mode, a, b, max] of [
    ["agy-master", true, false, 1], ["codex-master", false, true, 1],
    ["bidirectional", true, true, 2], ["off", false, false, 0],
  ]) {
    cli(["--mode", mode]);
    assert.deepEqual(readJson(f.file), { version: 1, directions: { [forward]: a, [reverse]: b }, max_depth: max, allow_cycles: false });
  }
  const before = { ...readJson(f.file), custom: { keep: true } };
  writeJson(f.file, before);
  // A hard link observes in-place truncation but retains the original bytes on rename.
  const link = path.join(f.dir, "original.json");
  fs.linkSync(f.file, link);
  cli(["--antigravity-to-codex", "false", "--max-depth", "7", "--mode", "bidirectional", "--allow-cycles", "true"]);
  assert.deepEqual(readJson(link), before);
  const expected = { ...before, directions: { [forward]: false, [reverse]: true }, max_depth: 7, allow_cycles: true };
  assert.deepEqual(readJson(f.file), expected);
  cli(["--codex-to-antigravity", "off"], 0, { AGENT_BRIDGE_MAX_DEPTH: "9" });
  expected.directions[reverse] = false;
  assert.deepEqual(readJson(f.file), expected);
  const status = cli(["--status"], 0, { AGENT_BRIDGE_MAX_DEPTH: "9" });
  assert.ok(status.includes(f.file));
  assert.match(status, /"max_depth": 9/);
  assert.match(status, /Codex registration: antigravity-local absent/);
  assert.deepEqual(readJson(f.file), expected);
  for (const invalid of [["--max-depth", "2junk"], ["--max-depth", "11"], ["--allow-cycles", "maybe"], ["--config", "relative"]]) cli(invalid, 1);
  assert.deepEqual(readJson(f.file), expected);
  assert.ok(!fs.readdirSync(f.dir).some((file) => file.endsWith(".tmp")));
});

test("Codex wiring checks ownership, merges env_vars in the correct table, and is idempotent", (t) => {
  const f = fixture(t), cli = configurator(f);
  const file = path.join(f.codexHome, "registration.json"), toml = path.join(f.codexHome, "config.toml");
  const calls = () => fs.readFileSync(path.join(f.codexHome, "calls"), "utf8").trim().split("\n");
  const unrelated = { transport: { type: "stdio", command: "other", args: [path.join(root, "server", "antigravity-mcp.mjs")] } };
  writeJson(file, unrelated);
  for (const flag of ["--wire-codex", "--unwire-codex"]) assert.match(cli([flag], 1), /different command.*--force/);
  assert.deepEqual(readJson(file), unrelated);
  assert.deepEqual(calls(), ["get", "get"]);
  cli(["--wire-codex", "--force"]);
  const wired = fs.readFileSync(toml, "utf8");
  assert.ok(wired.includes('[mcp_servers.antigravity-local]\r\nenv_vars = ["DECOY"]\r\n"""'));
  assert.ok(wired.includes('"CUSTOM", # keep this comment'));
  assert.ok(wired.includes('[other]\r\nenv_vars = ["UNRELATED"]'));
  assert.ok(BRIDGE_ENV_VARS.every((key) => wired.includes(JSON.stringify(key))));
  const added = calls().filter((verb) => verb === "add").length;
  cli(["--wire-codex"]);
  assert.equal(calls().filter((verb) => verb === "add").length, added);
  assert.equal(fs.readFileSync(toml, "utf8"), wired);
  assert.match(cli(["--status"]), /registered, forwarding configured/);
  cli(["--unwire-codex"]);
  cli(["--unwire-codex"]);
  assert.equal(calls().filter((verb) => verb === "remove").length, 1);
  cli(["--wire-codex"]); // fresh registration
  writeJson(file, unrelated);
  cli(["--unwire-codex", "--force"]);
  assert.equal(fs.existsSync(file), false);
  const count = calls().length;
  assert.match(cli(["--mode", "off", "--wire-codex", "--force"], 1, { FAIL_LOOKUP: "1" }), /Bridge config written:[\s\S]*Cannot read Codex config/);
  assert.deepEqual(calls().slice(count), ["get"]);
  assert.equal(readJson(f.file).max_depth, 0);
});
