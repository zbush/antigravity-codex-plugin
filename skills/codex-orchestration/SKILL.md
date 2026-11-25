---
name: codex-orchestration
description: >-
  Orchestrate local OpenAI Codex CLI agents through the codex-local MCP server.
  Use this skill whenever the user asks to delegate work to Codex, run parallel
  Codex workers, resume or fork a Codex thread, or ask Codex for a code review
  or second opinion.
---

# Local Codex Agent Orchestration

The `codex-local` MCP server wraps the locally installed `@openai/codex` CLI
(`codex exec`, `codex exec resume`, `codex exec fork`, and `codex exec review`)
so you can delegate bounded tasks and coordinate parallel Codex workers using
the user's existing local Codex auth and `~/.codex/config.toml`.

This plugin also ships the reverse MCP server (`antigravity-local`) so Codex can
delegate back to Antigravity CLI (`agy`) when enabled by the user. Both
directions are independently toggleable via `bridge.config.json` /
`node scripts/configure.mjs`, and delegation depth/cycles are enforced
automatically via `AGENT_BRIDGE_*` environment variables.

## Tool Selection

| Goal | Tool |
| :--- | :--- |
| Short scoped task (< ~2 min, wait for result) | `codex_run` |
| Longer task (> ~2 min) or 2+ parallel Codex workers | `codex_spawn` -> `codex_job_status` (and `codex_job_cancel` if needed) |
| Continue an earlier Codex thread | `codex_resume` (pass `session_id` or `last: true`) |
| Explore an alternative branch from an existing thread | `codex_fork` |
| Non-interactive code review (uncommitted, branch diff, or commit) | `codex_review` |

## Orchestration Guidelines

1. **Always pass an exact absolute `cwd`.** Never rely on implicit working directories.
2. **Use `codex_spawn` for deep research or multi-file implementation.** MCP host tool calls may time out after ~3 minutes; `codex_spawn` returns a `job_id` immediately so long-running Codex jobs complete safely in the background.
3. **Choose the narrowest `sandbox` mode needed:**
   - Use `sandbox: "read-only"` for codebase exploration, architecture audits, bug triage, and second opinions.
   - Use `sandbox: "workspace-write"` for implementation, refactoring, and test fixes.
   - Avoid `danger-full-access` unless the user explicitly asks for it.
4. **Isolate parallel writers with `worktree: true`.** When spawning multiple Codex agents that edit files in the same Git repository at the same time, pass `worktree: true` so their edits do not collide on the working tree.
5. **Write self-contained briefs.** Codex runs in its own fresh context and does not see this conversation. Include:
   - Concrete goal and scope (exact files/modules to inspect or change)
   - Constraints and conventions to follow
   - Verification criteria (tests/checks Codex should run) and expected output summary
6. **Respect delegation policy limits.** If `codex-local` exposes no tools or rejects a launch with `direction_disabled`, `max_depth_reached`, or `cycle_blocked`, do not try to work around the policy—finish the task locally or inform the user so they can adjust `node scripts/configure.mjs`.
7. **Leverage `session_id` for multi-turn loops.** Save the `session_id` returned by `codex_run` or `codex_job_status` so you can follow up with `codex_resume` instead of repeating full context.
8. **Verify before handing back.** After Codex modifies files, inspect the git diff or run tests yourself before reporting completion to the user.
