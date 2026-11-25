<p align="center">
  <img src="assets/logo.png" alt="Local Codex Orchestrator Logo" width="128" height="128" />
</p>

# Local Codex Orchestrator (Antigravity Plugin)

A zero-dependency [Google Antigravity](https://antigravity.google) plugin that lets Antigravity orchestrate your locally installed **OpenAI Codex CLI** (`@openai/codex`) through a bundled Model Context Protocol (MCP) stdio server.

> **Why a bundled MCP server?** Newer releases of `@openai/codex` removed the legacy `codex mcp-server` subcommand. This plugin bridges standard MCP over stdio directly to `codex exec --json`, `codex exec resume`, `codex exec fork`, and `codex exec review`, reusing your local Codex authentication and `~/.codex/config.toml`.

## Features

- **Zero dependencies** — pure Node.js ESM (`server/index.mjs`), no `npm install` required.
- **Cross-platform** — works on Windows, macOS, and Linux, with automatic discovery of `@openai/codex` across standard npm, `nvm`, `nvm-windows`, `fnm`, `volta`, Homebrew, and `PATH` installs.
- **Multi-agent orchestration** — run single synchronous tasks, resume or fork sessions by `session_id`, run non-interactive code reviews, or spawn parallel Codex agents in isolated Git worktrees.
- **Bundled orchestration skill** — includes `skills/codex-orchestration/SKILL.md` guiding Antigravity on sandboxing, worktree isolation, and verification.

## MCP Tools (`codex-local`)

| Tool | Description |
| :--- | :--- |
| `codex_run` | Run a scoped local Codex task synchronously (`sandbox`, `model`, `profile`, `worktree`, `add_dirs`) and return the final response, `session_id`, commands run, and token usage. |
| `codex_resume` | Continue an existing Codex thread by `session_id` (or `last: true`). |
| `codex_fork` | Fork an existing Codex session into a new independent thread. |
| `codex_review` | Run a non-interactive code review against uncommitted changes, a base branch (`base`), or a commit (`commit`). |
| `codex_spawn` | Launch a Codex task asynchronously in the background and return a `job_id` immediately for parallel fan-out. |
| `codex_job_status` | Poll a specific background `job_id` or list all tracked jobs. |
| `codex_job_cancel` | Cancel a running background Codex job. |

## Prerequisites

1. **Node.js 18+** (`node --version`)
2. **OpenAI Codex CLI** installed and authenticated locally:
   ```bash
   npm install -g @openai/codex
   codex --version
   codex login
   ```
3. **Google Antigravity** (App, IDE, or CLI)

## Installation

Clone this repository directly into Antigravity's global plugins directory as `codex`:

### macOS / Linux
```bash
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/zbush/antigravity-codex-plugin.git ~/.gemini/config/plugins/codex
```

### Windows (PowerShell)
```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.gemini\config\plugins" | Out-Null
git clone https://github.com/zbush/antigravity-codex-plugin.git "$env:USERPROFILE\.gemini\config\plugins\codex"
```

Antigravity automatically discovers plugins in `~/.gemini/config/plugins/`. Open **Customizations → Plugins** to confirm **Local Codex Orchestrator** is listed and enabled, or inspect **Additional Options (`...`) → MCP Servers** for `codex_codex-local`.

## Configuration (nvm, fnm, volta, Homebrew, or non-PATH setups)

By default, `mcp_config.json` uses portable defaults:

```json
{
  "mcpServers": {
    "codex-local": {
      "command": "node",
      "args": ["server/index.mjs"]
    }
  }
}
```

Antigravity launches plugin MCP servers with `cwd` set to the plugin root, and `server/index.mjs` resolves Codex in the following order:

1. `CODEX_BIN` environment variable — direct path to a `codex` binary or `.cmd` shim (e.g. Homebrew or standalone binary)
2. `CODEX_CLI_JS` environment variable — direct path to `@openai/codex/bin/codex.js` (invoked with the same Node executable)
3. Automatic lookup relative to `process.execPath`, `NPM_CONFIG_PREFIX`, and `%APPDATA%\npm` (Windows)
4. `codex` on `PATH`

If Antigravity is launched as a desktop/GUI app and does not inherit your shell's `nvm` / `nvm-windows` / `fnm` / `volta` `PATH`, edit your local `~/.gemini/config/plugins/codex/mcp_config.json` to pin explicit paths:

<details>
<summary><strong>Windows example (nvm-windows)</strong></summary>

Find your paths in PowerShell:
```powershell
where.exe node
npm prefix -g
```

Update `~/.gemini/config/plugins/codex/mcp_config.json`:
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

Find your paths:
```bash
which node
which codex
```

Update `~/.gemini/config/plugins/codex/mcp_config.json`:
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
*(Or set `CODEX_CLI_JS` to `.../lib/node_modules/@openai/codex/bin/codex.js` if installed via npm.)*
</details>

## Verifying the MCP Server

You can test the MCP stdio handshake directly from the plugin directory:

### macOS / Linux
```bash
cd ~/.gemini/config/plugins/codex
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"verify","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node server/index.mjs
```

### Windows (PowerShell)
```powershell
Set-Location "$env:USERPROFILE\.gemini\config\plugins\codex"
$init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"verify","version":"1.0"}}}'
$noti = '{"jsonrpc":"2.0","method":"notifications/initialized"}'
$list = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
"$init`n$noti`n$list" | node server/index.mjs
```

You should see JSON-RPC responses for `initialize` and `tools/list` listing all 7 `codex_*` tools.

## Troubleshooting

- **`codex` not found when invoked from Antigravity**: Set explicit `command` and `CODEX_BIN` / `CODEX_CLI_JS` paths in `mcp_config.json` (see above).
- **Windows sandbox directory access errors**: On Windows, Codex's restricted-token sandbox may deny shell access inside dot-folders under your user profile (such as `~/.gemini`). Point `cwd` at normal project directories.
- **Updating the plugin**: Run `git pull` inside `~/.gemini/config/plugins/codex` (if you edited `mcp_config.json` locally for explicit paths, stash or reapply your local override).

## License

MIT
