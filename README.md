<p align="center">
  <img src="assets/logo.png" alt="Antigravity <-> Codex Bridge Logo" width="128" height="128" />
</p>

# Antigravity ↔ Codex Bridge

A zero-dependency, **bidirectional** Model Context Protocol (MCP) plugin that lets **Google Antigravity** and **OpenAI Codex CLI** delegate work to each other—either in a strict master/worker hierarchy or freely back and forth as peers with built-in recursion and cycle protection.

- **Antigravity → Codex (`codex-local`)**: Antigravity delegates scoped implementation, code review, or parallel Git worktree tasks to your local `@openai/codex` CLI (`codex exec --json`, `resume`, `fork`, `review`).
- **Codex → Antigravity (`antigravity-local`)**: Codex delegates research, planning, editing, or structured-output tasks to your local Google Antigravity CLI (`agy --input-format stream-json --output-format stream-json`).
- **Independent direction controls**: Enable or disable either direction independently with a single shared policy file (`bridge.config.json`), CLI configurator (`scripts/configure.mjs`), or environment variables—no restart required.

> **Why a bundled MCP bridge?** Newer releases of `@openai/codex` removed the legacy `codex mcp-server` subcommand, and `agy` runs headless via NDJSON streams. Both servers here are pure Node.js ESM (`>= 18`), require zero `npm install`, reuse your existing local logins/configs, and share a unified loop-guard policy layer.

---

## Delegation Topologies

Configure the exact hierarchy you want via `node scripts/configure.mjs`:

| Topology | Preset Command | `antigravity_to_codex` | `codex_to_antigravity` | `max_depth` | Behavior |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **Antigravity Master** *(default)* | `--mode agy-master` | `true` | `false` | `1` | Antigravity delegates to Codex; Codex cannot call back to Antigravity. |
| **Codex Master** | `--mode codex-master` | `false` | `true` | `1` | Codex delegates to Antigravity; Antigravity cannot call back to Codex. |
| **Bidirectional Peers** | `--mode bidirectional` | `true` | `true` | `2` | Either model can initiate and delegate back up to `max_depth` hops (cycle-safe). |
| **Both Disabled** | `--mode off` | `false` | `false` | `0` | Both servers stay healthy (`initialize`/`ping`) while exposing no tools. |

You can also toggle each direction, `max_depth`, and `allow_cycles` independently (see [Configuring Directions & Loop Protection](#configuring-directions--loop-protection)).

---

## Prerequisites

Install whichever CLIs correspond to the direction(s) you plan to enable:

1. **Node.js 18+** (`node --version`)
2. **For Antigravity → Codex (`codex-local`)**:
   ```bash
   npm install -g @openai/codex
   codex --version
   codex login
   ```
3. **For Codex → Antigravity (`antigravity-local`)**:
   - **macOS / Linux**:
     ```bash
     curl -fsSL https://antigravity.google/cli/install.sh | bash
     agy --version
     ```
   - **Windows (PowerShell)**:
     ```powershell
     irm https://antigravity.google/cli/install.ps1 | iex
     agy --version
     ```
   - Authenticate once via an interactive `agy` session (or Antigravity App—credentials are shared locally).

---

## Installation

### 1. Clone the plugin into Antigravity's global plugins folder

**macOS / Linux:**
```bash
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/zbush/antigravity-codex-plugin.git ~/.gemini/config/plugins/codex
```

**Windows (PowerShell):**
```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.gemini\config\plugins" | Out-Null
git clone https://github.com/zbush/antigravity-codex-plugin.git "$env:USERPROFILE\.gemini\config\plugins\codex"
```

This immediately enables **Direction A (Antigravity → Codex)** in Antigravity (`Customizations → Plugins → Antigravity <-> Codex Bridge`).

### 2. Wire Direction B (Codex → Antigravity) *(optional)*

Run the built-in configurator from the installed plugin checkout to register `antigravity-local` in Codex (`~/.codex/config.toml`), configure `env_vars` forwarding for the loop guard, and choose your starting mode. If you wired Codex on an older version, rerun `node scripts/configure.mjs --wire-codex` from that checkout and then restart the host for the updated `AGENT_BRIDGE_INHERITED_POLICY` pass-through.

```bash
cd ~/.gemini/config/plugins/codex

# Example 1: Bidirectional peer-to-peer mode
node scripts/configure.mjs --mode bidirectional --wire-codex --status

# Example 2: Strict Codex-master hierarchy (Codex -> Antigravity only)
node scripts/configure.mjs --mode codex-master --wire-codex --status
```

<details>
<summary><strong>Manual Codex registration (alternative to <code>--wire-codex</code>)</strong></summary>

Register the server with `codex mcp add`:
```bash
codex mcp add antigravity-local -- node /absolute/path/to/.gemini/config/plugins/codex/server/antigravity-mcp.mjs
```

Then add `env_vars` under `[mcp_servers.antigravity-local]` in `~/.codex/config.toml` so delegation depth and policy overrides cross Codex's MCP boundary:
```toml
[mcp_servers.antigravity-local]
command = "node"
args = ["/absolute/path/to/.gemini/config/plugins/codex/server/antigravity-mcp.mjs"]
env_vars = [
  "AGENT_BRIDGE_DEPTH",
  "AGENT_BRIDGE_MAX_DEPTH",
  "AGENT_BRIDGE_CHAIN",
  "AGENT_BRIDGE_CONFIG",
  "AGENT_BRIDGE_INHERITED_POLICY",
  "AGENT_BRIDGE_ANTIGRAVITY_TO_CODEX",
  "AGENT_BRIDGE_CODEX_TO_ANTIGRAVITY",
  "AGENT_BRIDGE_ALLOW_CYCLES",
  "AGY_BIN",
  "CODEX_BIN",
  "CODEX_CLI_JS",
]
```
</details>

To remove `antigravity-local` from Codex later:
```bash
node scripts/configure.mjs --unwire-codex
```

---

## Configuring Directions & Loop Protection

### Config file & precedence

User policy is stored outside the plugin install folder so `git pull` or plugin updates never overwrite your preferences:
- **Default user policy file**: `~/.gemini/config/antigravity-codex-bridge/bridge.config.json`
- **Shipped defaults**: `./bridge.config.json` (`antigravity_to_codex: true`, `codex_to_antigravity: false`, `max_depth: 1`, `allow_cycles: false`)

When you supply a config path via `AGENT_BRIDGE_CONFIG` or `--config`, that path must be absolute and nonblank. Passing `--config` to `scripts/configure.mjs` selects its target file ahead of `AGENT_BRIDGE_CONFIG`. At runtime, an explicit config path pointing to a missing file fails closed.

Both servers reload the operator config live on every `tools/list` and `tools/call` in the precedence order below. On delegated hops, the child intersects that operator config with `AGENT_BRIDGE_INHERITED_POLICY` before admitting a handoff.

```text
Environment variables  >  User bridge.config.json (or AGENT_BRIDGE_CONFIG)  >  Shipped bridge.config.json  >  Built-in defaults
```

### CLI configurator (`scripts/configure.mjs`)

Unspecified flags preserve your existing settings:

```bash
# Inspect effective policy and Codex MCP registration
node scripts/configure.mjs --status

# Switch presets
node scripts/configure.mjs --mode agy-master
node scripts/configure.mjs --mode codex-master
node scripts/configure.mjs --mode bidirectional
node scripts/configure.mjs --mode off

# Toggle directions independently
node scripts/configure.mjs --antigravity-to-codex on --codex-to-antigravity off
node scripts/configure.mjs --codex-to-antigravity on --max-depth 2

# Allow deeper multi-hop back-and-forth (e.g., A -> B -> A -> B up to 4 hops)
node scripts/configure.mjs --mode bidirectional --max-depth 4 --allow-cycles on
```

### Policy schema (`bridge.config.json`)

```json
{
  "version": 1,
  "directions": {
    "antigravity_to_codex": true,
    "codex_to_antigravity": true
  },
  "max_depth": 2,
  "allow_cycles": false
}
```

### How live policy & loop guards work

1. **Disabled direction**: The server still responds to `initialize` and `ping`, returns an empty `tools: []` list (emitting `notifications/tools/list_changed` if disabled live), cancels owned jobs, and rejects any cached `tools/call` with JSON-RPC error `-32602` (`data.reason: "direction_disabled"`).
2. **Depth, cycles, and inherited limits.** Each parent forwards the incremented `AGENT_BRIDGE_DEPTH`, the updated `AGENT_BRIDGE_CHAIN`, and its effective policy in `AGENT_BRIDGE_INHERITED_POLICY`. A child can use a direction only when both inherited and current operator settings enable it. The lower `max_depth` applies, and both policies must permit cycles.
   - `depth = 0` is a top-level user session.
   - When `depth >= max_depth`, launch tools (`*_run`, `*_spawn`, `*_resume`, `*_fork`, `*_review`) are hidden and rejected (`data.reason: "max_depth_reached"`), while `*_job_status` and `*_job_cancel` remain available.
   - When `allow_cycles` is `false` (default), repeating a direction already present in `AGENT_BRIDGE_CHAIN` is blocked (`data.reason: "cycle_blocked"`), allowing `A → B → A` at `max_depth: 2` while preventing ping-pong loops. Set `allow_cycles: true` with a bounded `max_depth` if you want deeper back-and-forth chains.
3. **Fail-closed validation.** A nonzero `AGENT_BRIDGE_DEPTH` without `AGENT_BRIDGE_INHERITED_POLICY` refuses the launch. The bridge also fails closed on malformed JSON, invalid policy values, blank or relative `AGENT_BRIDGE_CONFIG` paths, missing explicit `AGENT_BRIDGE_CONFIG` files at runtime, and inconsistent `AGENT_BRIDGE_DEPTH` and `AGENT_BRIDGE_CHAIN` values.

### Environment variable overrides

| Variable | Values | Purpose |
| :--- | :--- | :--- |
| `AGENT_BRIDGE_CONFIG` | Nonblank absolute file path | Shared override path for runtime and `scripts/configure.mjs`. Missing explicit files fail closed at runtime, and `--config` selects the configurator target ahead of this variable. |
| `AGENT_BRIDGE_ANTIGRAVITY_TO_CODEX` | `true` / `false` (`on`/`off`) | Override Antigravity → Codex direction. |
| `AGENT_BRIDGE_CODEX_TO_ANTIGRAVITY` | `true` / `false` (`on`/`off`) | Override Codex → Antigravity direction. |
| `AGENT_BRIDGE_MAX_DEPTH` | Integer `0..10` | Maximum delegated hop depth. |
| `AGENT_BRIDGE_ALLOW_CYCLES` | `true` / `false` (`on`/`off`) | Allow repeating a direction in the same chain up to `max_depth`. |
| `CODEX_BIN` | File path | Explicit `codex` binary or `.cmd` shim path. |
| `CODEX_CLI_JS` | File path | Explicit `@openai/codex/bin/codex.js` path (run via `process.execPath`). |
| `AGY_BIN` | File path | Explicit `agy` executable path (defaults auto-check `%LOCALAPPDATA%\agy\bin\agy.exe`, `~/.local/bin/agy`, Homebrew, and `PATH`). |

---

## MCP Tool Reference

### Antigravity → Codex (`codex-local`)

| Tool | Description |
| :--- | :--- |
| `codex_run` | Run a scoped local Codex task synchronously (`prompt`, `cwd`, `sandbox`, `model`, `profile`, `worktree`, `add_dirs`, `skip_git_repo_check`, `ephemeral`, `timeout_seconds`) and return `session_id`, response, commands run, and token usage. |
| `codex_resume` | Continue an existing Codex thread by `session_id` (or `last: true`). |
| `codex_fork` | Fork an existing Codex session into a new independent thread. |
| `codex_review` | Run a non-interactive code review against uncommitted changes, a `base` branch, or a `commit` SHA. |
| `codex_spawn` | Start a Codex task (`run`/`resume`/`fork`/`review`) in the background and return a `job_id` immediately (recommended for parallel workers or tasks > ~2 minutes). |
| `codex_job_status` | Inspect a background `job_id` or list all tracked Codex jobs. |
| `codex_job_cancel` | Terminate a running background Codex job and its process tree. |

### Codex → Antigravity (`antigravity-local`)

| Tool | Description |
| :--- | :--- |
| `antigravity_run` | Run a local Antigravity CLI turn synchronously (`prompt`, `cwd`, optional `resume: { conversation_id }` or `resume: { continue_last: true }`, `model`, `agent`, `effort`, `mode`, `add_dirs`, `sandbox`, `disable_slash_commands`, `json_schema`, `timeout_seconds`) and return `conversation_id`, response, `structured_output`, and token usage. |
| `antigravity_spawn` | Start a background Antigravity turn and return a `job_id` immediately for parallel fan-out or long tasks. |
| `antigravity_job_status` | Inspect a background `job_id` or list all tracked Antigravity jobs. |
| `antigravity_job_cancel` | Terminate a running background Antigravity job and its process tree. |

---

## Non-PATH / Version Manager Setup (`nvm`, `fnm`, `volta`, Homebrew)

By default, `mcp_config.json` uses portable defaults (`command: "node"`, `args: ["server/index.mjs"]`) because Antigravity runs plugin MCP servers with `cwd` set to the plugin root.

On Windows, automatic discovery checks `%LOCALAPPDATA%\agy\bin\agy.exe` and `PATH` for `agy`, and resolves `codex` from `PATH` (including `.cmd` shims). Setting `CODEX_CLI_JS` runs `@openai/codex/bin/codex.js` directly through Node and skips `.cmd` shim lookup. When a desktop or GUI host omits your shell `PATH`, pin explicit paths in your local `~/.gemini/config/plugins/codex/mcp_config.json` as shown below.

<details>
<summary><strong>Windows example (nvm-windows)</strong></summary>

```json
{
  "mcpServers": {
    "codex-local": {
      "command": "C:\\nvm4w\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\<YOUR_USER>\\.gemini\\config\\plugins\\codex\\server\\index.mjs"
      ],
      "env": {
        "CODEX_CLI_JS": "C:\\nvm4w\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js"
      }
    }
  }
}
```
</details>

<details>
<summary><strong>macOS / Linux example (nvm or Homebrew)</strong></summary>

```json
{
  "mcpServers": {
    "codex-local": {
      "command": "/Users/<YOUR_USER>/.nvm/versions/node/v22.x.x/bin/node",
      "args": [
        "/Users/<YOUR_USER>/.gemini/config/plugins/codex/server/index.mjs"
      ],
      "env": {
        "CODEX_BIN": "/opt/homebrew/bin/codex"
      }
    }
  }
}
```
</details>

---

## Testing & Verification

Run the built-in zero-dependency test suite (covers config precedence, live toggling, depth/cycle guards, both MCP servers over stdio, cancellation, timeouts, and Codex wiring):

```bash
node --test tests/bridge.test.mjs
```

### Troubleshooting

- **Synchronous MCP call times out after ~3 minutes**: Some MCP hosts enforce a ~3-minute per-call timeout. Use `codex_spawn` / `antigravity_spawn` + `*_job_status` for multi-file tasks or deep research.
- **`codex` or `agy` not found from a GUI app**: Set `CODEX_BIN` / `CODEX_CLI_JS` / `AGY_BIN` in your MCP registration or pin the absolute `node` path.
- **Windows Codex sandbox directory errors**: On Windows, Codex's restricted-token sandbox may deny shell access inside dot-folders under your user profile (such as `~/.gemini`). Point `cwd` at normal project directories.

## Repository Layout

```text
├── plugin.json                     # Antigravity plugin manifest
├── mcp_config.json                 # Antigravity -> Codex MCP registration
├── bridge.config.json              # Shipped default direction & depth policy
├── assets/logo.png                 # Plugin icon
├── server/
│   ├── index.mjs                   # Backward-compatible entry point (-> codex-mcp.mjs)
│   ├── codex-mcp.mjs               # Antigravity -> Codex MCP server (codex-local)
│   ├── antigravity-mcp.mjs         # Codex -> Antigravity MCP server (antigravity-local)
│   └── lib/
│       ├── bridge.mjs              # Config loading, precedence, direction/depth/cycle guard
│       ├── mcp.mjs                 # Shared JSON-RPC 2.0 stdio transport
│       └── process.mjs             # Path helpers, batch escaping, job registry, tree kill
├── scripts/
│   └── configure.mjs               # CLI for toggling directions & wiring Codex MCP
├── skills/
│   └── codex-orchestration/
│       └── SKILL.md                # Antigravity orchestration skill
└── tests/
    └── bridge.test.mjs             # node:test end-to-end & policy test suite
```

## License

MIT
