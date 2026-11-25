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
import { resolveCodexInvocation } from "../server/lib/codex-cli.mjs";
import { createJobRegistry, findWindowsCommand } from "../server/lib/process.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const forward = DIRECTIONS.ANTIGRAVITY_TO_CODEX;
const reverse = DIRECTIONS.CODEX_TO_ANTIGRAVITY;
const policy = {
  version: 1, directions: { [forward]: true, [reverse]: true }, max_depth: 4, allow_cycles: false,
};
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const attributed = (sender, receiver, prompt) => [
  "AGENT-TO-AGENT DELEGATION",
  `Sending agent: ${sender}. Receiving agent: ${receiver}.`,
  `This task was delegated by ${sender} on the user's behalf. The human may not have seen the sending conversation. Attribute relayed claims to ${sender}.`,
  "---", prompt,
].join("\n");

// Written into the fixture as a standalone CommonJS CLI, with no project imports.
async function mockAgy() {
  if (process.argv[2] === "--version") return console.log("agy fixture 1.0");
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  if (input.split("\n").length !== 2 || !input.endsWith("\n")) throw new Error("Expected a single NDJSON line");
  const message = JSON.parse(input);
  const prompt = message.message.content.split("\n---\n").at(-1);
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
      message, args: process.argv.slice(2), cwd: process.cwd(), allowEdits: process.env.AGENT_BRIDGE_ALLOW_EDITS,
      depth: process.env.AGENT_BRIDGE_DEPTH, chain: process.env.AGENT_BRIDGE_CHAIN,
      maxDepth: JSON.parse(process.env.AGENT_BRIDGE_INHERITED_POLICY ?? "{}").max_depth,
    },
  };
  if (prompt === "cli error") result.error = "model error";
  // Split a record across writes and omit the final newline.
  const line = JSON.stringify({ event: "result", result });
  process.stdout.write(line.slice(0, 12));
  setImmediate(() => process.stdout.write(line.slice(12)));
}

async function mockCodex() {
  if (process.argv[2] === "--version") return console.log("codex fixture 1.0");
  if (!process.argv.includes("exec")) throw new Error("Expected codex exec");
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  const context = {
    depth: process.env.AGENT_BRIDGE_DEPTH, chain: process.env.AGENT_BRIDGE_CHAIN,
    maxDepth: JSON.parse(process.env.AGENT_BRIDGE_INHERITED_POLICY).max_depth, prompt,
    args: process.argv.slice(2), allowEdits: process.env.AGENT_BRIDGE_ALLOW_EDITS,
  };
  console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-id" }));
  if (prompt.endsWith("\n---\nlinger")) return setInterval(() => {}, 10000);
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
    AGENT_BRIDGE_WORKSPACE_ROOTS: JSON.stringify([dir]), AGENT_BRIDGE_ALLOW_EDITS: "true",
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
  async function request(method, params = {}, id = ++nextId) {
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
    notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); },
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
  writeJson(file, { directions: { [reverse]: true }, max_depth: 3, max_concurrent: 2 });
  assert.equal(loadBridgeConfig({ AGENT_BRIDGE_CONFIG: file }).config.max_concurrent, 2);
  const env = { AGENT_BRIDGE_CONFIG: file, AGENT_BRIDGE_ANTIGRAVITY_TO_CODEX: "off", AGENT_BRIDGE_MAX_DEPTH: "5", AGENT_BRIDGE_MAX_CONCURRENT: "3" };
  const loaded = loadBridgeConfig(env);
  assert.deepEqual(loaded.sources, [SHIPPED_CONFIG_PATH, file]);
  assert.deepEqual(loaded.config, { ...shipped, directions: { [forward]: false, [reverse]: true }, max_depth: 5, max_concurrent: 3 });
  assert.equal(evaluateDelegationPolicy(forward, env).reason, "direction_disabled");
  assert.equal(evaluateDelegationPolicy(reverse, env).allowed, true);
  assert.equal(loadBridgeConfig({ AGENT_BRIDGE_CONFIG: file }).config.directions[forward], shipped.directions[forward]);
});

test("invalid policies and malformed delegation contexts fail closed", (t) => {
  const { file, env } = fixture(t);
  for (const invalid of [
    { max_depth: -1 }, { max_depth: 11 }, { max_depth: "2junk" }, { max_depth: null },
    { max_concurrent: 0 }, { max_concurrent: null }, { max_concurrent: 1.5 }, { max_concurrent: true },
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
    ...["", "0", "-1", "1.5", "1junk", "9007199254740992"].map(value => ({ AGENT_BRIDGE_MAX_CONCURRENT: value })),
  ]) assert.throws(() => loadBridgeConfig({ ...env, ...overrides }));
  for (const [depth, chain] of [
    ["1", ""], ["", "[]"], ["1", "bad"], ["0", "{}"], ["1", "[]"], ["1x", JSON.stringify([forward])],
    ["1", '["unknown"]'], ["1", JSON.stringify([reverse])], ["2", JSON.stringify([forward, forward])],
  ]) {
    assert.equal(evaluateDelegationPolicy(reverse, {
      ...env, AGENT_BRIDGE_DEPTH: depth, AGENT_BRIDGE_CHAIN: chain,
    }).reason, "invalid_context");
  }
});

test("depth, repeated hops, and child environment propagation", (t) => {
  const { env, file } = fixture(t);
  const base = { ...env, AGENT_BRIDGE_DEPTH: "2", AGENT_BRIDGE_CHAIN: JSON.stringify([reverse, forward]),
    AGENT_BRIDGE_INHERITED_POLICY: JSON.stringify({ ...policy, allow_cycles: true }) };
  assert.deepEqual(readDelegationContext({}), { depth: 0, chain: [] });
  assert.equal(evaluateDelegationPolicy(reverse, base).reason, "cycle_blocked");
  assert.equal(evaluateDelegationPolicy(reverse, { ...base, AGENT_BRIDGE_MAX_DEPTH: "2" }).reason, "max_depth_reached");
  const evaluation = evaluateDelegationPolicy(reverse, { ...base, AGENT_BRIDGE_ALLOW_CYCLES: "true" });
  assert.equal(evaluation.allowed, true);
  const child = buildChildBridgeEnv(reverse, evaluation, { ...base, PRESERVED: "yes" });
  assert.deepEqual(child.nextChain, [reverse, forward, reverse]);
  assert.equal(child.nextDepth, 3);
  const parsed = readDelegationContext(child.env);
  assert.equal(parsed.depth, 3);
  assert.deepEqual(parsed.chain, child.nextChain);
  assert.equal(parsed.envelope.remaining_hops, evaluation.config.max_depth - 3);
  assert.deepEqual(JSON.parse(child.env.AGENT_BRIDGE_INHERITED_POLICY), evaluation.config);
  assert.deepEqual([child.env.AGENT_BRIDGE_CONFIG, child.env.PRESERVED, base.AGENT_BRIDGE_DEPTH], [file, "yes", "2"]);
});

test("nested servers honor revocation and cannot gain authority from a looser policy file", t => {
  const { env, file } = fixture(t);
  writeJson(file, { ...policy, max_depth: 2, max_concurrent: 1 });
  const child = buildChildBridgeEnv(forward, evaluateDelegationPolicy(forward, env), env).env;
  assert.equal(evaluateDelegationPolicy(reverse, child).reason, "cycle_blocked");
  writeJson(file, { ...policy, directions: { [forward]: true, [reverse]: false } });
  assert.equal(evaluateDelegationPolicy(reverse, child).reason, "direction_disabled");
  writeJson(file, { ...policy, max_depth: 8, allow_cycles: true });
  const after = evaluateDelegationPolicy(reverse, child);
  assert.equal(after.config.max_depth, 2);
  assert.equal(after.config.max_concurrent, 1);
  assert.equal(after.config.allow_cycles, false);
  assert.equal(evaluateDelegationPolicy(reverse, { ...child, AGENT_BRIDGE_INHERITED_POLICY: "{}" }).reason, "invalid_config");
});

test("a foreign handoff can reach a third agent, and a callback requires cycles and hop budget", t => {
  const { env } = fixture(t);
  const incoming = { version: 1, hops: [{ from: "claude", to: "antigravity", id: "receipt" }], remaining_hops: 2 };
  const foreign = { ...env, AGENT_BRIDGE_CONTEXT: JSON.stringify(incoming) };
  const first = evaluateDelegationPolicy(forward, foreign);
  assert.equal(first.allowed, true);
  const child = buildChildBridgeEnv(forward, first, foreign).env;
  assert.equal(evaluateDelegationPolicy(reverse, child).reason, "cycle_blocked");
  const cyclic = { ...foreign, AGENT_BRIDGE_ALLOW_CYCLES: "true" };
  const permittedChild = buildChildBridgeEnv(forward, evaluateDelegationPolicy(forward, cyclic), cyclic).env;
  const second = evaluateDelegationPolicy(reverse, permittedChild);
  assert.equal(second.allowed, true);
  const leaf = buildChildBridgeEnv(reverse, second, permittedChild).env;
  const outgoing = JSON.parse(leaf.AGENT_BRIDGE_CONTEXT);
  assert.deepEqual(outgoing.hops[0], incoming.hops[0]);
  assert.equal(outgoing.remaining_hops, 0);
  assert.equal(evaluateDelegationPolicy(forward, leaf).reason, "max_depth_reached");
  assert.equal(evaluateDelegationPolicy(reverse, foreign).reason, "invalid_context");
  assert.equal(evaluateDelegationPolicy(forward, { ...foreign, AGENT_BRIDGE_CONTEXT: "{}" }).reason, "invalid_context");
});

for (const [name, direction, incoming] of [["codex", forward, reverse], ["antigravity", reverse, forward]]) {
  test(name + " stdio initialization, delegation, and live policy enforcement", async (t) => {
    const f = fixture(t);
    const nested = { AGENT_BRIDGE_DEPTH: "1", AGENT_BRIDGE_CHAIN: JSON.stringify([incoming]) };
    const legacy = f.connect(name, nested);
    assert.ok(!(await legacy.tools()).includes(name + "_run"));
    const denied = await legacy.call(name + "_run", { cwd: f.dir, prompt: "fixture" });
    assertDenied(denied, "invalid_config");
    assert.match(denied.error.message, /configure\.mjs --wire-codex/);
    const cycles = { ...policy, allow_cycles: true };
    writeJson(f.file, cycles);
    const client = f.connect(name, { ...nested, AGENT_BRIDGE_INHERITED_POLICY: JSON.stringify(cycles) });
    const init = (await client.request("initialize", { protocolVersion: "2024-11-05" })).result;
    const icon = fs.readFileSync(path.join(root, "assets", "icon-64.png"), "base64");
    assert.deepEqual(init.serverInfo, {
      name: name + "-local", version: "2.1.0",
      icons: [{ src: "data:image/png;base64," + icon, mimeType: "image/png", sizes: ["64x64"] }],
    });
    assert.equal(init.capabilities.tools.listChanged, true);
    const run = name + "_run";
    const inspect = [name + "_job_status", name + "_job_cancel", name + "_status"];
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
    assert.equal(context.maxDepth, 4);
    if (name === "codex") {
      assert.equal(context.prompt, attributed("Google Antigravity", "Codex", args.prompt));
      assert.equal(job.session_id, "codex-id");
    } else {
      assert.deepEqual(context.message, { event: "user", message: { content: attributed("Codex", "Google Antigravity", args.prompt) } });
      assert.equal(context.allowEdits, "false");
      assert.deepEqual(context.args, ["--input-format", "stream-json", "--output-format", "stream-json",
        "--mode", "plan", "--sandbox", "--disable-slash-commands", "--print-timeout", "600s"]);
      assert.equal(context.cwd, fs.realpathSync.native(f.dir));
    }
    writeJson(f.file, policy);
    assert.deepEqual(await client.tools(), inspect);
    assertDenied(await client.call(run, args), "cycle_blocked");
    assert.equal(payload(await client.call(name + "_status", {})).reason, "cycle_blocked");
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

test("launches enforce operator roots, edit permissions and bounded session reuse", async t => {
  const f = fixture(t);
  const safe = f.connect("codex", { AGENT_BRIDGE_ALLOW_EDITS: "false" });
  const args = { cwd: f.dir, prompt: "test" };
  const deny = async (client, tool, values) => assert.equal((await client.call(tool, values)).error.code, -32602);
  for (const override of [{ sandbox: "workspace-write" }, { sandbox: "danger-full-access" }, { worktree: true },
    { profile: "extra" }, { cwd: path.dirname(f.dir) }, { add_dirs: [path.dirname(f.dir)] }]) {
    await deny(safe, "codex_run", { ...args, ...override });
  }
  await deny(safe, "codex_fork", { ...args, session_id: "unknown" });
  const verify = (job, sandbox) => {
    const record = JSON.parse(job.response);
    assert.equal(record.args[record.args.indexOf("-s") + 1], sandbox);
    assert.equal(record.args[record.args.indexOf("-a") + 1], "never");
    assert.ok(record.args.includes("--ignore-user-config"));
    assert.equal(record.allowEdits, String(sandbox === "workspace-write"));
  };
  const run = payload(await safe.call("codex_run", args));
  verify(run, "read-only");
  verify(payload(await safe.call("codex_resume", { ...args, session_id: run.session_id })), "read-only");
  verify(payload(await safe.call("codex_review", args)), "read-only");
  const editing = f.connect("codex");
  const writable = { ...args, sandbox: "workspace-write" };
  const session = payload(await editing.call("codex_run", writable));
  verify(session, "workspace-write");
  const schemas = (await editing.request("tools/list")).result.tools;
  for (const name of ["codex_resume", "codex_fork"]) {
    assert.deepEqual(schemas.find(tool => tool.name === name).inputSchema.properties.sandbox.enum, ["read-only", "workspace-write"]);
    await deny(editing, name, { ...args, session_id: session.session_id });
    verify(payload(await editing.call(name, { ...writable, session_id: session.session_id })), "workspace-write");
  }
  for (const invalid of [{ ...args, typo: true }, { cwd: f.dir }, { ...args, prompt: " " }, { ...args, prompt: {} }]) {
    await deny(editing, "codex_run", invalid);
  }
  await deny(editing, "codex_spawn", { ...args, mode: "invalid" });
  await deny(f.connect("antigravity", { AGENT_BRIDGE_ALLOW_EDITS: "false" }), "antigravity_spawn", args);
});

test("Windows delegates receive only an operator-selected sandbox backend", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  const args = { cwd: f.dir, prompt: "test" };
  const selected = f.connect("codex", { AGENT_BRIDGE_CODEX_WINDOWS_SANDBOX: "elevated" });
  const record = JSON.parse(payload(await selected.call("codex_run", args)).response);
  assert.ok(record.args.includes('windows.sandbox="elevated"'));
  const invalid = f.connect("codex", { AGENT_BRIDGE_CODEX_WINDOWS_SANDBOX: "unknown" });
  const denied = await invalid.call("codex_run", args);
  assert.match(denied.error.message, /Invalid AGENT_BRIDGE_CODEX_WINDOWS_SANDBOX/);
});

test("Codex review sends attributed custom instructions and leaves target-only reviews clean", async t => {
  const f = fixture(t), client = f.connect("codex");
  const review = async params => JSON.parse(payload(await client.call("codex_review", { cwd: f.dir, ...params })).response);
  for (const params of [{}, { base: "main" }, { prompt: "   " }]) {
    const { prompt, args } = await review(params);
    assert.equal(prompt, "");
    assert.ok(args.includes(params.base ? "--base" : "--uncommitted"));
    assert.ok(!args.includes("-"));
  }
  const custom = await review({ prompt: "Check error handling" });
  assert.equal(custom.prompt, attributed("Google Antigravity", "Codex", "Check error handling"));
  assert.equal(custom.args.at(-1), "-");
  assert.ok(!custom.args.includes("--uncommitted"));
});

for (const [name, binEnv] of [["codex", "CODEX_CLI_JS"], ["antigravity", "AGY_BIN"]]) {
  test(name + " reports diagnostics while at capacity and restores launch tools on completion", async t => {
    const f = fixture(t);
    const client = f.connect(name, { AGENT_BRIDGE_MAX_CONCURRENT: "1" });
    await client.request("initialize");
    const args = { cwd: f.dir, prompt: "linger" };
    const busy = payload(await client.call(name + "_spawn", args));
    assert.deepEqual(client.notifications, ["notifications/tools/list_changed"]);
    assert.deepEqual(await client.tools(), [name + "_job_status", name + "_job_cancel", name + "_status"]);
    for (const tool of ["_run", "_spawn"]) assertDenied(await client.call(name + tool, args), "max_concurrent_reached");
    const status = payload(await client.call(name + "_status", {}));
    assert.equal(status.binary, f.env[binEnv]);
    assert.equal(status.binary_source, binEnv);
    assert.equal(status.version, (name === "codex" ? "codex" : "agy") + " fixture 1.0");
    assert.equal(status.reason, "max_concurrent_reached");
    assert.equal(status.launch_allowed, false);
    assert.equal(status.active_jobs, 1);
    assert.equal(status.max_concurrent, 1);
    assert.equal(status.bridge_policy.max_concurrent, 1);
    assert.deepEqual(status.workspace_policy.roots, [fs.realpathSync.native(f.dir)]);
    assert.equal(status.workspace_policy.allow_edits, true);
    assert.equal(payload(await client.call(name + "_job_cancel", { job_id: busy.job_id })).cancelled, true);
    const until = Date.now() + 10000;
    while (!(await client.tools()).includes(name + "_run")) {
      assert.ok(Date.now() < until, "Job slot was not released");
      await delay(30);
    }
    assert.equal(payload(await client.call(name + "_status", {})).active_jobs, 0);
    assert.deepEqual(client.notifications, ["notifications/tools/list_changed", "notifications/tools/list_changed"]);
    const missing = f.connect(name, { [binEnv]: path.join(f.dir, "absent") });
    const diagnostic = payload(await missing.call(name + "_status", {}), true);
    assert.equal(diagnostic.binary, null);
    assert.match(diagnostic.binary_error, new RegExp(binEnv));
    assert.deepEqual((await missing.request("ping")).result, {});
  });

  test(name + " notifications/cancelled terminates the synchronous request's process tree", async t => {
    const f = fixture(t);
    const marker = path.join(f.dir, "pids.json");
    const source = `
      const fs = require("node:fs"), { spawn } = require("node:child_process");
      const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 12000)"], { stdio: "ignore", windowsHide: true });
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, descendant.pid]));
      setTimeout(() => {}, 12000);
    `;
    fs.writeFileSync(f.env[binEnv], source);
    const client = f.connect(name);
    const id = "sync-turn";
    const pending = client.request("tools/call", { name: name + "_run", arguments: { cwd: f.dir, prompt: "wait" } }, id);
    const until = Date.now() + 5000;
    while (!fs.statSync(marker, { throwIfNoEntry: false })?.size) {
      assert.ok(Date.now() < until, "Child process did not start");
      await delay(20);
    }
    const pids = readJson(marker);
    client.notify("notifications/cancelled", { requestId: "different-turn" });
    assert.equal(payload(await client.call(name + "_job_status", {})).jobs[0].status, "running");
    client.notify("notifications/cancelled", { requestId: id });
    assert.equal(payload(await pending, true).status, "cancelled");
    const stopped = pid => {
      try {
        process.kill(pid, 0);
        // Containers can leave a killed orphan waiting for PID 1 to reap it.
        return process.platform === "linux" && /\) Z /.test(fs.readFileSync("/proc/" + pid + "/stat", "utf8"));
      } catch (error) {
        if (error.code === "ESRCH" || error.code === "ENOENT") return true;
        throw error;
      }
    };
    const deadline = Date.now() + 2000;
    while (!pids.every(stopped)) {
      assert.ok(Date.now() < deadline, "A cancelled child or descendant is still running");
      await delay(20);
    }
    assert.deepEqual((await client.request("ping")).result, {});
  });
}

test("a stalled CLI version probe times out without blocking other MCP requests", async t => {
  const f = fixture(t), client = f.connect("codex");
  fs.writeFileSync(f.env.CODEX_CLI_JS, "setTimeout(() => {}, 30000);");
  const pending = client.call("codex_status", {});
  assert.deepEqual((await client.request("ping")).result, {});
  const status = payload(await pending, true);
  assert.equal(status.binary, f.env.CODEX_CLI_JS);
  assert.match(status.version_error, /timed out/);
  assert.equal(status.version, null);
});

test("early CLI exit while the server writes the prompt preserves a successful result", async t => {
  const f = fixture(t);
  const output = {
    codex: { type: "item.completed", item: { type: "agent_message", text: "done" } },
    antigravity: { event: "result", result: { status: "SUCCESS", response: "done" } },
  };
  for (const [name, file] of [["codex", f.env.CODEX_CLI_JS], ["antigravity", f.env.AGY_BIN]]) {
    fs.writeFileSync(file, "console.log(" + JSON.stringify(JSON.stringify(output[name])) + ");");
    const client = f.connect(name);
    const job = payload(await client.call(name + "_run", { cwd: f.dir, prompt: "x".repeat(2 * 1024 * 1024) }));
    assert.equal(job.response, "done");
    assert.deepEqual(job.errors, []);
    assert.deepEqual((await client.request("ping")).result, {});
  }
});

test("Codex bounds stdout and final-message reads, and removes each private output directory", async t => {
  const f = fixture(t);
  const record = path.join(f.dir, "last-path.json");
  const client = f.connect("codex");
  async function run(body, error) {
    fs.writeFileSync(f.env.CODEX_CLI_JS, `
      const fs = require("node:fs");
      const file = process.argv[process.argv.indexOf("-o") + 1];
      fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(file));
      process.stdin.resume();
      ${body}
    `);
    const job = payload(await client.call("codex_run", { cwd: f.dir, prompt: "fixture" }), Boolean(error));
    const dir = path.dirname(readJson(record));
    assert.match(path.basename(dir), /^codex-mcp-/);
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.equal(fs.existsSync(dir), false);
    if (error) {
      assert.equal(job.status, "failed");
      assert.match(job.errors.join(" "), error);
    }
    return job;
  }
  assert.equal((await run('fs.writeFileSync(file, "small response");')).response, "small response");
  await run("fs.writeFileSync(file, Buffer.alloc(4 * 1024 * 1024 + 1));", /final message exceeded 4 MiB/);
  await run('process.stdout.write("x".repeat(4 * 1024 * 1024 + 1));', /stdout exceeded 4 MiB/);
  await run('process.stdout.write(("x".repeat(1023) + "\\n").repeat(4097));', /stdout exceeded 4 MiB/);
});

test("finished job retention preserves session scope and counts after dropping older output", () => {
  const registry = createJobRegistry();
  for (let id = 0; id <= 50; id++) {
    const job = { job_id: id, session_id: "s" + id, cwd: "workspace", status: "completed",
      sandbox: "workspace-write", additionalRoots: [], response: "answer", commands: ["a"], file_changes: [],
      stderr: "logs", errors: ["details"], usage: {}, recent_events: ["event"], cancel() {} };
    registry.jobs.set(id, job);
    registry.finish(job, {});
  }
  const oldest = registry.jobs.get(0);
  assert.ok(oldest.output_pruned);
  assert.equal(oldest.response, "");
  assert.deepEqual(oldest.commands, []);
  assert.equal(oldest.commands_run, 1);
  assert.equal(oldest.stderr, "");
  assert.deepEqual(oldest.recent_events, []);
  assert.deepEqual([oldest.cwd, oldest.sandbox, oldest.session_id, oldest.additionalRoots], ["workspace", "workspace-write", "s0", []]);
  assert.equal(registry.jobs.get(1).response, "answer");
  assert.equal(registry.jobs.get(50).cancel, undefined);
});

test("Antigravity maps launch flags and requires a successful terminal result and exit", async (t) => {
  const f = fixture(t);
  const client = f.connect("antigravity");
  const call = (params) => client.call("antigravity_run", { cwd: f.dir, prompt: "test", ...params });
  const schema = { type: "object", description: 'some "text" & a %VARIABLE%' };
  const result = payload(await call({
    model: "test model", effort: "high", mode: "accept-edits",
    add_dirs: [f.dir, f.codexHome], json_schema: schema, timeout_seconds: 25,
  }));
  assert.deepEqual(result.structured_output.args, [
    "--input-format", "stream-json", "--output-format", "stream-json", "--model", "test model",
    "--effort", "high", "--mode", "accept-edits", "--add-dir", fs.realpathSync.native(f.dir), "--add-dir", fs.realpathSync.native(f.codexHome),
    "--sandbox", "--disable-slash-commands",
    "--json-schema", JSON.stringify(schema), "--print-timeout", "25s",
  ]);
  assert.equal(result.conversation_id, "agy-id");
  assert.equal(result.structured_output.allowEdits, "true");
  assert.equal(result.response, "final answer");
  assert.deepEqual(result.usage, { total_tokens: 12 });
  assert.deepEqual(result.recent_events.map((e) => e.event), ["init", "step_update", "step_update", "result"]);
  for (const params of [{ resume: {} }, { resume: { continue_last: true } }, { agent: "override" }, { sandbox: false }, { disable_slash_commands: false },
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
    command: process.execPath, args: [f.env.AGY_BIN, "flag"], shell: false, binary: f.env.AGY_BIN, source: "AGY_BIN",
  });
  const env = { PATH: f.dir, HOME: f.dir, USERPROFILE: f.dir, LOCALAPPDATA: f.dir };
  assert.throws(() => resolveAgyInvocation([], { ...env, AGY_BIN: path.join(f.dir, "missing") }), /AGY_BIN/);
  if (process.platform === "win32") assert.throws(() => resolveAgyInvocation([], env), /absolute executable path/);
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
    for (const [name, resolve, key] of [["agy", resolveAgyInvocation, "AGY_BIN"], ["codex", resolveCodexInvocation, "CODEX_BIN"]]) {
      for (const extension of [".cmd", ".BAT"]) {
        const shim = path.join(f.dir, name + extension);
        fs.writeFileSync(shim, "");
        assert.throws(() => resolve([], { ...env, [key]: shim }), /\.exe.*JavaScript/);
      }
      assert.throws(() => findWindowsCommand(name, env), /absolute executable path/);
      const exe = path.join(f.dir, name + ".exe");
      fs.writeFileSync(exe, "");
      assert.equal(findWindowsCommand(name, { PATH: '"' + f.dir + '"' }), exe);
      fs.unlinkSync(exe);
    }
    const entry = path.join(f.dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "");
    assert.equal(findWindowsCommand("codex", { PATH: '"' + f.dir + '"' }), entry);
  }
});

function mockRegistration() {
  const fs = require("node:fs"), path = require("node:path");
  const home = process.env.CODEX_HOME.trim(), file = path.join(home, "registration.json");
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
    if (fs.existsSync(file)) throw new Error("Registration already exists");
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

test("isolated Codex runs reconstruct only the enabled standard peer registration", async t => {
  const f = fixture(t);
  const cfg = configurator(f);
  cfg(["--wire-codex"]);
  fs.writeFileSync(f.env.CODEX_CLI_JS, "process.argv[2] === 'mcp' ? (" + mockRegistration.toString() + ")() : (" + mockCodex.toString() + ")();");
  const client = f.connect("codex");
  const peerIsPresent = async () => {
    const job = payload(await client.call("codex_run", { cwd: f.dir, prompt: "fixture" }));
    return JSON.parse(job.response).args.some(arg => arg.startsWith("mcp_servers.antigravity-local.command="));
  };
  assert.equal(await peerIsPresent(), false);
  writeJson(f.file, { ...policy, allow_cycles: true });
  assert.equal(await peerIsPresent(), true);
  const meta = path.join(f.codexHome, "registration.json");
  const info = readJson(meta);
  writeJson(meta, { ...info, enabled: false });
  assert.equal(await peerIsPresent(), false);
  writeJson(meta, { ...info, transport: { ...info.transport, args: ["some-other-server"] } });
  assert.equal(await peerIsPresent(), false);
  writeJson(meta, info);
  fs.appendFileSync(path.join(f.codexHome, "config.toml"), "\n[mcp_servers.antigravity-local.tools.antigravity_spawn]\napproval_mode = 'ask'\n");
  assert.equal(await peerIsPresent(), false);
});

test("configurator edits the runtime environment-selected file", t => {
  const f = fixture(t);
  const run = spawnSync(process.execPath, [path.join(root, "scripts/configure.mjs"), "--max-depth", "2"], {
    env: { ...f.env, HOME: f.dir, USERPROFILE: f.dir }, encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readJson(f.file).max_depth, 2);
  assert.equal(fs.existsSync(path.join(f.dir, ".gemini")), false);
});

test("configurator applies presets then overrides, replaces atomically and reports effective status", (t) => {
  const f = fixture(t), cli = configurator(f);
  fs.unlinkSync(f.file);
  for (const [mode, a, b, max] of [
    ["agy-master", true, false, 1], ["codex-master", false, true, 1],
    ["bidirectional", true, true, 1], ["off", false, false, 0],
  ]) {
    cli(["--mode", mode]);
    assert.deepEqual(readJson(f.file), { version: 1, directions: { [forward]: a, [reverse]: b }, max_depth: max, max_concurrent: 4, allow_cycles: false });
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
  cli(["--wire-codex", "--force"], 0, { CODEX_HOME: "  " + f.codexHome + " " });
  assert.deepEqual(calls().slice(2), ["get", "remove", "add", "get"]);
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
  assert.equal(calls().filter((verb) => verb === "remove").length, 2);
  cli(["--wire-codex"]); // fresh registration
  writeJson(file, unrelated);
  cli(["--unwire-codex", "--force"]);
  assert.equal(fs.existsSync(file), false);
  const count = calls().length;
  assert.match(cli(["--mode", "off", "--wire-codex", "--force"], 1, { FAIL_LOOKUP: "1" }), /Bridge config written:[\s\S]*Cannot read Codex config/);
  assert.deepEqual(calls().slice(count), ["get"]);
  assert.equal(readJson(f.file).max_depth, 0);
});
